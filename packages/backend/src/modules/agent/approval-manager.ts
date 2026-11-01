/**
 * 审批管理器 —— 权限确认与 AskUserQuestion 两类挂起的统一枢纽。
 *
 * pi 侧（tool_call 门 / ask 工具 execute）await approvals.create(...) 挂起；
 * Web 侧任一 tab 调 settle → 幂等终结 + 总线广播 approval_settled → 所有 tab 弹框消失。
 * 四路兜底 rejectAll：REST settle / 会话 close / janitor 回收 / abort，不留死锁。
 */

import { isDeepStrictEqual } from "node:util";
import type {
	AgentStatus,
	PendingKind,
	PendingPayload,
	PendingRequest,
	RunMode,
} from "@pi-agent/common";
import type { SessionEventBus } from "./event-bus";

export interface ApprovalOutcome {
	action: "allow" | "deny" | "answer" | "cancelled";
	data?: unknown;
	reason?: string;
}

export interface ApprovalPersistence {
	find: (id: string) => { request: PendingRequest; outcome?: ApprovalOutcome } | undefined;
	write: (request: PendingRequest, outcome?: ApprovalOutcome) => void;
}

interface Entry {
	request: PendingRequest;
	resolve: (value: unknown) => void;
	settled: boolean;
	cleanup: () => void;
}

export interface ApprovalOptions {
	signal?: AbortSignal;
	timeout?: number;
	onTimeout?: () => ApprovalOutcome;
}

/** 权限门拿到的判定结果 */
export interface ToolPermissionResult {
	allowed: boolean;
	reason?: string;
}

export const USER_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalManager {
	private entries = new Map<string, Entry>();
	private resumeStatus: AgentStatus = "idle";

	constructor(
		private readonly bus: SessionEventBus,
		private persistence?: ApprovalPersistence,
	) {
		bus.subscribe((event) => {
			if (event.event === "status" && event.data.status !== "awaiting-approval") {
				this.resumeStatus = event.data.status;
			}
		});
	}

	/**
	 * 注册挂起请求并广播 approval_request；返回的 Promise 挂起直到 settle。
	 * tool_permission 以 toolCallId 为 requestId，其余以新生成 uuid。
	 */
	create(
		kind: PendingKind,
		id: string,
		payload: PendingPayload,
		options: ApprovalOptions = {},
	): Promise<unknown> {
		if (this.entries.has(id)) {
			// 同 id 重复挂起只可能来自异常路径：立即以 cancel 语义 resolve，避免双写
			return Promise.resolve(
				kind === "tool_permission" ? { allowed: false, reason: "重复的审批请求" } : undefined,
			);
		}
		const timeout =
			options.timeout !== undefined && Number.isFinite(options.timeout)
				? Math.max(0, options.timeout)
				: undefined;
		const saved = this.persistence?.find(id);
		if (
			saved &&
			(saved.request.kind !== kind ||
				!isDeepStrictEqual(
					kind === "tool_permission"
						? { ...saved.request.payload, runMode: undefined }
						: saved.request.payload,
					kind === "tool_permission" ? { ...payload, runMode: undefined } : payload,
				))
		)
			throw new Error("恢复审批与原工具参数不一致，已阻止执行");
		if (saved?.outcome) return Promise.resolve(approvalValue(kind, saved.outcome));
		const createdAt = Date.now();
		const request: PendingRequest = saved?.request ?? {
			requestId: id,
			kind,
			payload,
			createdAt,
			...(timeout !== undefined ? { expiresAt: createdAt + timeout } : {}),
		};
		this.persistence?.write(request);
		return new Promise<unknown>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let persistenceFailed = false;
			const automatic = (outcome: () => ApprovalOutcome) => {
				if (timer !== undefined) clearTimeout(timer);
				try {
					this.settle(id, outcome());
				} catch (error) {
					if (!persistenceFailed)
						this.bus.publish({
							event: "error",
							data: {
								message: `审批结果保存失败，仍保持等待，将自动重试：${error instanceof Error ? error.message : String(error)}`,
							},
						});
					persistenceFailed = true;
					timer = setTimeout(() => automatic(outcome), 1000);
				}
			};
			const cancel = () => automatic(() => ({ action: "cancelled", reason: "操作已取消" }));
			this.entries.set(id, {
				request,
				resolve: (value) => {
					// 总线事件在 settle 时广播（含本 Promise resolve 的那次），顺序：settled 先行
					resolve(value);
				},
				settled: false,
				cleanup: () => {
					if (timer !== undefined) clearTimeout(timer);
					options.signal?.removeEventListener("abort", cancel);
				},
			});
			options.signal?.addEventListener("abort", cancel, { once: true });
			if (request.expiresAt !== undefined) {
				timer = setTimeout(
					() =>
						automatic(
							() => options.onTimeout?.() ?? { action: "cancelled", reason: "等待用户操作超时" },
						),
					Math.max(0, request.expiresAt - Date.now()),
				);
			}
			if (this.entries.size === 1)
				this.bus.publish({ event: "status", data: { status: "awaiting-approval" } });
			this.bus.publish({ event: "approval_request", data: request });
			if (options.signal?.aborted) cancel();
		});
	}

	/**
	 * 终结挂起请求。幂等：已 settled 返回 false（重复点击被挡）。
	 * 广播 approval_settled 后 resolve pi 侧挂起的 Promise。
	 */
	settle(id: string, outcome: ApprovalOutcome): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.settled) return false;
		this.persistence?.write(entry.request, outcome);
		entry.settled = true;
		entry.cleanup();
		this.entries.delete(id);
		this.bus.publish({
			event: "approval_settled",
			data: { requestId: id, outcome: outcome.action, reason: outcome.reason },
		});
		if (this.entries.size === 0)
			this.bus.publish({ event: "status", data: { status: this.resumeStatus } });
		entry.resolve(approvalValue(entry.request.kind, outcome));
		return true;
	}

	/** 会话 close / janitor / abort 兜底：全部以 cancelled 语义终结 */
	rejectAll(reason: string): void {
		for (const [id] of this.entries) {
			this.settle(id, { action: "cancelled", reason });
		}
	}

	pendingList(): PendingRequest[] {
		return [...this.entries.values()].map((e) => e.request);
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): PendingRequest | undefined {
		return this.entries.get(id)?.request;
	}

	/** 仅用于进程退出：撤销本进程计时和监听，不将持久化的待审批项改为取消。 */
	suspend(): void {
		for (const entry of this.entries.values()) entry.cleanup();
		this.entries.clear();
	}

	setPersistence(persistence: ApprovalPersistence): void {
		if (this.entries.size) throw new Error("不能替换已有审批的持久化配置");
		this.persistence = persistence;
	}

	hasRestoredPending(id: string): boolean {
		const saved = this.persistence?.find(id);
		return saved?.request.kind === "tool_permission" && saved.outcome === undefined;
	}
}

function approvalValue(kind: PendingKind, outcome: ApprovalOutcome): unknown {
	if (kind === "tool_permission")
		return { allowed: outcome.action === "allow", reason: outcome.reason };
	if (kind === "ui_confirm")
		return outcome.action === "allow" || (outcome.action === "answer" && outcome.data === true);
	return outcome.action === "answer" ? outcome.data : undefined;
}

/** 权限门便捷封装：把用户动作翻译成 pi 的 ToolCallEventResult 语义 */
export async function requestToolPermission(
	approvals: ApprovalManager,
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
	runMode: RunMode | (() => RunMode),
): Promise<ToolPermissionResult> {
	const currentMode = () => (typeof runMode === "function" ? runMode() : runMode);
	const r = await approvals.create(
		"tool_permission",
		toolCallId,
		{ toolName, input, runMode: currentMode() },
		{
			timeout: USER_APPROVAL_TIMEOUT_MS,
			onTimeout: () => {
				const denied = currentMode() === "safe";
				return {
					action: denied ? "deny" : "allow",
					reason: denied
						? "等待权限确认超时，按当前安全模式拒绝"
						: "等待权限确认超时，按当前运行模式允许",
				};
			},
		},
	);
	if (r && typeof r === "object" && "allowed" in r) return r as ToolPermissionResult;
	// 未收到结构化答案（cancel 兜底）一律拒绝
	return { allowed: false, reason: "审批未完成" };
}
