import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSettingsInput } from "@pi-agent/common/dto/requests";
import { createApp } from "../src/core/create-app";
import { env } from "../src/env";
import {
	closeSession,
	getHistory,
	removeQueueItem,
	setModel,
	setThinking,
	settleApproval,
} from "../src/modules/agent/agent.service";
import { ApprovalManager } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { EventTranslator, messageIdOf } from "../src/modules/agent/event-translator";
import { projectMessages } from "../src/modules/agent/history";
import type { SessionContext } from "../src/modules/agent/session-registry";
import { registry } from "../src/modules/agent/session-registry";
import { configureTestModels } from "./helpers";

const restores: Array<() => void> = [];
function modelFixture() {
	const previous = env.dataDir;
	const dir = mkdtempSync(join(tmpdir(), "pi-model-mutation-"));
	(env as { dataDir: string }).dataDir = dir;
	configureTestModels("review-user", ["new", "m"], "p");
	restores.push(() => {
		(env as { dataDir: string }).dataDir = previous;
		rmSync(dir, { recursive: true, force: true });
	});
}
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
const user = { userId: "review-user", username: "review" };
const settingsQueue = {
	subscribe: () => () => {},
	getSteeringMessages: () => [],
	getFollowUpMessages: () => [],
};
const emptyStats = {
	getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	sessionManager: { getEntries: () => [] },
};

describe("会话业务对接回归", () => {
	test("关闭其他用户会话不触发 dispose", async () => {
		const get = spyOn(registry, "get").mockReturnValue(undefined);
		const close = spyOn(registry, "close").mockResolvedValue();
		restores.push(
			() => get.mockRestore(),
			() => close.mockRestore(),
		);
		await closeSession(user, "another-session");
		expect(close).not.toHaveBeenCalled();
	});
	test("删除 steering 保留 followUp", async () => {
		let steering = ["s1", "s2"],
			followUp = ["f1"];
		const session = {
			subscribe: () => () => {},
			getSteeringMessages: () => steering,
			getFollowUpMessages: () => followUp,
			clearQueue: () => {
				steering = [];
				followUp = [];
			},
			steer: async (text: string) => {
				steering.push(text);
			},
			followUp: async (text: string) => {
				followUp.push(text);
			},
		};
		await removeQueueItem({ session } as unknown as SessionContext, 0, "steer");
		expect({ steering, followUp }).toEqual({ steering: ["s2"], followUp: ["f1"] });
	});
	test("思考强度广播实际生效值", async () => {
		const events: unknown[] = [];
		const ctx = {
			session: { ...settingsQueue, thinkingLevel: "off", setThinkingLevel() {} },
			bus: { publish: (e: unknown) => events.push(e) },
		};
		await setThinking(ctx as unknown as SessionContext, "max");
		expect(events).not.toContainEqual({ event: "thinking_level_changed", data: { level: "max" } });
	});
	test("模型认证仍在等待时，随后修改的思考强度必须在新模型上应用", async () => {
		modelFixture();
		const runtime = spyOn(registry, "modelRuntimeFor").mockResolvedValue({
			getModel: () => ({ provider: "p", id: "new" }),
		} as never);
		restores.push(() => runtime.mockRestore());
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const changes: string[] = [];
		const ctx = {
			session: {
				...settingsQueue,
				setModel: async () => {
					await ready;
					changes.push("model");
				},
				setThinkingLevel: (level: string) => {
					changes.push(level);
				},
				getAvailableThinkingLevels: () => ["off", "high"],
			},
			bus: { publish() {} },
		} as unknown as SessionContext;
		const switching = setModel(user, ctx, "p", "new");
		const thinking = setThinking(ctx, "high");
		await Promise.resolve();
		expect(changes).toEqual([]);
		release();
		await Promise.all([switching, thinking]);
		expect(changes).toEqual(["model", "off", "high"]);
	});
	test("模型拒绝切换时接口失败且不广播成功", async () => {
		modelFixture();
		const runtime = spyOn(registry, "modelRuntimeFor").mockResolvedValue({
			getModel: () => ({ provider: "p", id: "m" }),
		} as never);
		restores.push(() => runtime.mockRestore());
		const events: unknown[] = [];
		const failure = new Error("missing credentials");
		// 提前挂拒绝处理，旧实现丢弃 SDK Promise 也不会制造测试进程未处理拒绝。
		const rejected = Promise.reject(failure);
		void rejected.catch(() => {});
		const appliedThinking: string[] = [];
		const ctx = {
			session: {
				...settingsQueue,
				setModel: () => rejected,
				setThinkingLevel: (level: string) => appliedThinking.push(level),
			},
			bus: { publish: (e: unknown) => events.push(e) },
		};
		await expect(setModel(user, ctx as unknown as SessionContext, "p", "m")).rejects.toThrow();
		expect(events).toEqual([]);
		await setThinking(ctx as unknown as SessionContext, "high");
		expect(appliedThinking).toEqual(["high"]);
	});
	test("history 包含在途消息以及完整状态", () => {
		const partial = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "正在生成" }],
		};
		const ctx = {
			sessionId: "s",
			cwd: "D:/workspace",
			status: "responding",
			session: {
				...emptyStats,
				state: { streamingMessage: partial },
				messages: [{ role: "user", timestamp: 1, content: "你好" }],
				thinkingLevel: "off",
				isCompacting: false,
				getAvailableThinkingLevels: () => ["off"],
				getSteeringMessages: () => ["排队"],
				getFollowUpMessages: () => [],
			},
			translator: new EventTranslator(),
			bus: { currentSeq: 12 },
			runMode: { mode: "safe" },
			approvals: { pendingList: () => [] },
		};
		const history = getHistory(ctx as unknown as SessionContext);
		expect(history.messages).toHaveLength(2);
		expect(history).toMatchObject({
			sessionId: "s",
			seq: 12,
			status: "responding",
			queue: { steering: ["排队"] },
		});
	});
	test("权限审批不能用 answer 数据绕过动作校验", () => {
		const approvals = new ApprovalManager(new SessionEventBus());
		void approvals.create("tool_permission", "permission", {
			toolName: "write",
			input: {},
			runMode: "safe",
		});
		expect(() =>
			settleApproval({ approvals } as SessionContext, "permission", {
				action: "answer",
				data: { allowed: true },
			}),
		).toThrow();
		expect(approvals.has("permission")).toBe(true);
		approvals.rejectAll("cleanup");
	});
	test("必答题缺少答案时保留挂起请求", () => {
		const approvals = new ApprovalManager(new SessionEventBus());
		void approvals.create("ask_question", "question", {
			questions: [{ question: "请选择", options: [{ label: "A" }], allowCustom: false }],
		});
		expect(() =>
			settleApproval({ approvals } as SessionContext, "question", {
				action: "answer",
				data: { answers: {} },
			}),
		).toThrow();
		expect(approvals.has("question")).toBe(true);
		approvals.rejectAll("cleanup");
	});
});

test("用户和助手同毫秒消息不会共用ID", () => {
	expect(messageIdOf({ role: "user", timestamp: 10 } as never)).not.toBe(
		messageIdOf({ role: "assistant", timestamp: 10 } as never),
	);
});

test("同毫秒多条用户消息在SSE和快照中都有独立ID", () => {
	const translator = new EventTranslator();
	const messages = ["第一条", "第二条", "第三条"].map((content) => ({
		role: "user",
		timestamp: 10,
		content,
	}));
	const ids = messages
		.map((message) => translator.translate({ type: "message_start", message } as never)[0])
		.map((event) => {
			if (event?.event !== "user_message") throw new Error("预期用户消息事件");
			return event.data.uuid;
		});
	expect(new Set(ids).size).toBe(3);
	expect(new Set(projectMessages(messages).map((message) => message.id)).size).toBe(3);
});

test("首个delta之前的助手占位不能从history丢失", () => {
	expect(projectMessages([{ role: "assistant", timestamp: 1, content: [] }])).toMatchObject([
		{ id: "assistant:1", type: "assistant", blocks: [] },
	]);
});

test("Web模型配置拒绝各级命令与服务器环境变量引用", () => {
	const interpolation = ["$", "{JWT_SECRET}"].join("");
	for (const value of [
		"!echo fixture",
		"$JWT_SECRET",
		`Bearer ${interpolation}`,
		`prefix-${interpolation}`,
	]) {
		for (const provider of [
			{ apiKey: value },
			{ headers: { Authorization: value } },
			{ models: [{ id: "fixture", headers: { Authorization: value } }] },
			{ modelOverrides: { fixture: { headers: { Authorization: value } } } },
		])
			expect(ModelSettingsInput.safeParse({ providers: { fixture: provider } }).success).toBe(
				false,
			);
	}
});
test("纯图片工具结果保留图片", () => {
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const events = new EventTranslator().translate({
		type: "tool_execution_end",
		toolCallId: "image",
		result: { content: [image] },
		isError: false,
	} as never);
	expect(events[0]?.data).toMatchObject({ images: [image] });
});

test("运行中工具的快照保留状态与最新部分输出", () => {
	const translator = new EventTranslator();
	translator.translate({
		type: "tool_execution_update",
		toolCallId: "tool",
		partialResult: { content: [{ type: "text", text: "已经执行到第二步" }] },
	} as never);
	const ctx = {
		sessionId: "s",
		cwd: "D:/workspace",
		status: "tool-use",
		translator,
		session: {
			...emptyStats,
			messages: [
				{
					role: "assistant",
					timestamp: 1,
					content: [
						{ type: "toolCall", id: "tool", name: "bash", arguments: { command: "long-task" } },
					],
				},
			],
			state: {},
			thinkingLevel: "off",
			isCompacting: false,
			getAvailableThinkingLevels: () => ["off"],
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
		},
		bus: { currentSeq: 12 },
		runMode: { mode: "standard" },
		approvals: { pendingList: () => [] },
	};
	const history = getHistory(ctx as unknown as SessionContext);
	expect(history.messages[0]).toMatchObject({
		blocks: [{ status: "running", result: { content: "已经执行到第二步" } }],
	});
});
test("历史保留压缩摘要、自定义可见消息与中断状态", () => {
	const history = projectMessages([
		{ role: "compactionSummary", summary: "上下文摘要", content: "上下文摘要", timestamp: 1 },
		{ role: "custom", content: "扩展通知", display: true, timestamp: 2 },
		{
			role: "assistant",
			content: [{ type: "text", text: "部分回答" }],
			stopReason: "aborted",
			timestamp: 3,
		},
	] as never[]);
	expect(history).toHaveLength(3);
	expect(history[2]).toMatchObject({ stopReason: "aborted" });
});
test("未知路由保留404，允许单文件前端回退", async () => {
	const response = await createApp().handle(new Request("http://localhost/chat"));
	expect(response.status).toBe(404);
});
