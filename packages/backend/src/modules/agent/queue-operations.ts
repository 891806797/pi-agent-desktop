import type { QueueDispatchInput } from "@pi-agent/common/dto/requests";
import { AppError } from "@/core/app-error";
import type { SessionContext } from "./session-registry";

type Images = Parameters<SessionContext["session"]["steer"]>[1];
type Behavior = "steer" | "followUp";
interface Item {
	id?: string;
	text: string;
	images?: Images;
}
interface QueueState {
	tail: Promise<unknown>;
	queues: Record<Behavior, Item[]>;
	recovery: Record<Behavior, Item[]>;
	incoming?: Images;
	incomingId?: string;
	clearing: boolean;
	consumption: number;
	revision: number;
	dispatches: Map<string, { signature: string; result: Promise<void> }>;
}
const states = new WeakMap<SessionContext, QueueState>();

function stateFor(ctx: SessionContext): QueueState {
	let state = states.get(ctx);
	if (state) return state;
	state = {
		tail: Promise.resolve(),
		queues: { steer: [], followUp: [] },
		recovery: { steer: [], followUp: [] },
		clearing: false,
		consumption: 0,
		revision: 0,
		dispatches: new Map(),
	};
	states.set(ctx, state);
	const current = state;
	ctx.session.subscribe((event) => {
		if (event.type === "queue_update") {
			sync(current, event.steering, event.followUp);
			publishSnapshot(ctx);
		}
	});
	sync(current, ctx.session.getSteeringMessages(), ctx.session.getFollowUpMessages());
	return current;
}

function sync(state: QueueState, steering: readonly string[], followUp: readonly string[]) {
	if (
		state.queues.steer.length !== steering.length ||
		state.queues.steer.some((item, i) => item.text !== steering[i]) ||
		state.queues.followUp.length !== followUp.length ||
		state.queues.followUp.some((item, i) => item.text !== followUp[i])
	)
		state.revision++;
	for (const behavior of ["steer", "followUp"] as const) {
		const texts = behavior === "steer" ? steering : followUp;
		const previous = state.queues[behavior];
		// SDK 消费同名文本时移除第一次出现的位置，反向匹配才能保留后一个条目的附件。
		if (texts.length < previous.length && !state.clearing) state.consumption++;
		if (texts.length >= previous.length && previous.every((item, i) => item.text === texts[i])) {
			state.queues[behavior] = [
				...previous,
				...texts
					.slice(previous.length)
					.map((text) => ({ id: state.incomingId, text, images: state.incoming })),
			];
		} else {
			let cursor = previous.length - 1;
			const next: Item[] = new Array(texts.length);
			for (let i = texts.length - 1; i >= 0; i--) {
				while (cursor >= 0 && previous[cursor]!.text !== texts[i]) cursor--;
				next[i] = cursor >= 0 ? previous[cursor--]! : { text: texts[i]! };
			}
			state.queues[behavior] = next;
		}
	}
}

/** 仅串行同一会话的 Web 变更；发送锁在 SDK 接受输入后即释放。 */
export function queueTransaction<T>(ctx: SessionContext, action: () => Promise<T>): Promise<T> {
	const state = stateFor(ctx);
	const operation = state.tail.catch(() => {}).then(action);
	state.tail = operation;
	return operation;
}

export async function captureQueuedImages<T>(
	ctx: SessionContext,
	images: Images,
	action: () => Promise<T>,
	inputId?: string,
): Promise<T> {
	await recoverPending(ctx);
	const state = stateFor(ctx);
	state.incoming = images;
	state.incomingId = inputId;
	try {
		return await action();
	} finally {
		state.incoming = undefined;
		state.incomingId = undefined;
	}
}

export function clearSessionQueue(ctx: SessionContext): void {
	const state = stateFor(ctx);
	if (recoveryCount(state)) state.revision++;
	state.recovery = { steer: [], followUp: [] };
	state.clearing = true;
	try {
		ctx.session.clearQueue();
		sync(state, ctx.session.getSteeringMessages(), ctx.session.getFollowUpMessages());
	} finally {
		state.clearing = false;
	}
}

export function queueSnapshot(ctx: SessionContext): {
	steering: string[];
	followUp: string[];
	revision: number;
} {
	const recovery = states.get(ctx)?.recovery;
	return {
		revision: states.get(ctx)?.revision ?? 0,
		steering: [
			...ctx.session.getSteeringMessages(),
			...(recovery?.steer.map((item) => item.text) ?? []),
		],
		followUp: [
			...ctx.session.getFollowUpMessages(),
			...(recovery?.followUp.map((item) => item.text) ?? []),
		],
	};
}

/** 恢复检查点保留队列轨道、身份和附件；不改变公开队列协议。 */
export function queueEntries(ctx: SessionContext) {
	const state = stateFor(ctx);
	if (!state.clearing)
		sync(state, ctx.session.getSteeringMessages(), ctx.session.getFollowUpMessages());
	const entries = (items: Item[]) =>
		items.map((item) => {
			item.id ??= crypto.randomUUID();
			return { ...item, id: item.id };
		});
	return {
		clearing: state.clearing,
		steer: entries([...state.queues.steer, ...state.recovery.steer]),
		followUp: entries([...state.queues.followUp, ...state.recovery.followUp]),
	};
}

/** SDK 暂时不能接收的恢复输入沿用现有待恢复队列，保持页面可见、可重试。 */
export function retainSessionInputs(
	ctx: SessionContext,
	inputs: Array<Item & { behavior: Behavior }>,
): void {
	const state = stateFor(ctx);
	for (const item of inputs) {
		if (
			[
				...state.queues.steer,
				...state.queues.followUp,
				...state.recovery.steer,
				...state.recovery.followUp,
			].some((current) => current.id === item.id)
		)
			continue;
		state.recovery[item.behavior].push(item);
	}
	publishSnapshot(ctx);
}

/** 执行恢复前移交给检查点重建，避免宿主待恢复队列重复入 SDK。 */
export function releaseRetainedInputs(ctx: SessionContext): void {
	const state = stateFor(ctx);
	if (recoveryCount(state)) state.revision++;
	state.recovery = { steer: [], followUp: [] };
}

function recoveryCount(state: QueueState): number {
	return state.recovery.steer.length + state.recovery.followUp.length;
}

function publishSnapshot(ctx: SessionContext): void {
	ctx.bus.publish({ event: "queue_update", data: queueSnapshot(ctx) });
}

function recoveryError(ctx: SessionContext, cause: unknown): AppError {
	const count = recoveryCount(stateFor(ctx));
	const message = `队列恢复未完成，保留 ${count} 条待恢复；请重试发送/编辑或清空队列：${cause instanceof Error ? cause.message : "SDK 入队失败"}`;
	publishSnapshot(ctx);
	ctx.bus.publish({ event: "error", data: { message } });
	return new AppError("AGENT_ERROR", message);
}

async function enqueue(ctx: SessionContext, kind: Behavior, item: Item): Promise<void> {
	const state = stateFor(ctx);
	state.incoming = item.images;
	state.incomingId = item.id;
	try {
		if (kind === "steer") await ctx.session.steer(item.text, item.images, { source: "rpc" });
		else await ctx.session.followUp(item.text, item.images, { source: "rpc" });
	} finally {
		state.incoming = undefined;
		state.incomingId = undefined;
	}
}

async function recoverPending(ctx: SessionContext): Promise<void> {
	const state = stateFor(ctx);
	for (const kind of ["steer", "followUp"] as const) {
		while (state.recovery[kind].length) {
			if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭");
			const item = state.recovery[kind].shift()!;
			try {
				await enqueue(ctx, kind, item);
			} catch (error) {
				state.recovery[kind].unshift(item);
				throw recoveryError(ctx, error);
			}
		}
	}
}

export async function editSessionQueue(
	ctx: SessionContext,
	index: number,
	behavior: Behavior,
	targetBehavior?: Behavior,
	expectedText?: string,
	prioritize = false,
	expectedRevision?: number,
): Promise<void> {
	const beforeRecovery = stateFor(ctx);
	if (expectedRevision !== undefined && beforeRecovery.revision !== expectedRevision)
		throw new AppError("SESSION_BUSY", "队列已更新，请刷新后重试");
	await recoverPending(ctx);
	const state = stateFor(ctx);
	sync(state, ctx.session.getSteeringMessages(), ctx.session.getFollowUpMessages());
	if (expectedRevision !== undefined && state.revision !== expectedRevision)
		throw new AppError("SESSION_BUSY", "队列已更新，请刷新后重试");
	const original = { steer: [...state.queues.steer], followUp: [...state.queues.followUp] };
	const desired = { steer: [...original.steer], followUp: [...original.followUp] };
	const selected = desired[behavior][index];
	if (!selected) throw new AppError("NOT_FOUND", "队列条目不存在");
	if (expectedText !== undefined && selected.text !== expectedText)
		throw new AppError("SESSION_BUSY", "队列已更新，请重试");
	desired[behavior].splice(index, 1);
	if (targetBehavior) {
		if (prioritize) desired[targetBehavior].unshift(selected);
		else desired[targetBehavior].push(selected);
	}
	// SDK 没有“不展开模板的原样入队”接口；拒绝可能再次展开的文本，保留原队列。
	if ([...original.steer, ...original.followUp].some((item) => item.text.startsWith("/"))) {
		throw new AppError(
			"SESSION_BUSY",
			"队列包含以 / 开头的内容，无法保证原样重排，请清空后重新发送",
		);
	}
	const version = state.consumption;
	let remaining: Record<Behavior, Item[]> = { steer: [], followUp: [] };
	const assertOpen = () => {
		if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭，队列修改已停止");
	};
	const restore = async (queues: typeof original) => {
		assertOpen();
		clearSessionQueue(ctx);
		remaining = { steer: [...queues.steer], followUp: [...queues.followUp] };
		for (const kind of ["steer", "followUp"] as const) {
			while (remaining[kind].length) {
				assertOpen();
				await enqueue(ctx, kind, remaining[kind][0]!);
				remaining[kind].shift();
				assertOpen();
			}
		}
		// 消费已插入条目不影响继续提交未插入部分；全部补齐后才报告部分成功。
		if (state.consumption !== version)
			throw new AppError(
				"SESSION_BUSY",
				"智能体已消费队列，修改已部分生效，其余两轨输入已保留，请刷新确认",
			);
	};
	try {
		await restore(desired);
		if (!targetBehavior && selected.id) ctx.recovery?.rejectInput(selected.id);
	} catch (error) {
		// 消费后回滚会重复提交已执行输入；保留 SDK 当前队列并明确告知调用方。
		if (ctx.closing) throw error;
		if (state.consumption !== version) {
			state.recovery = remaining;
			if (recoveryCount(state)) throw recoveryError(ctx, error);
			throw error;
		}
		try {
			await restore(original);
		} catch (restoreError) {
			if (ctx.closing) throw restoreError;
			state.recovery = remaining;
			if (!recoveryCount(state) && state.consumption !== version) throw restoreError;
			throw recoveryError(ctx, restoreError);
		}
		throw new AppError(
			"AGENT_ERROR",
			`队列修改失败，已恢复原队列：${error instanceof Error ? error.message : "请重试"}`,
		);
	}
}

/** Web 组合操作：去重、过期校验、停止当前运行、发送选中项、恢复其余两轨。 */
export function dispatchQueuedMessage(
	ctx: SessionContext,
	input: QueueDispatchInput,
): Promise<void> {
	const state = stateFor(ctx);
	const signature = JSON.stringify(input);
	const existing = state.dispatches.get(input.requestId);
	if (existing) {
		if (existing.signature !== signature)
			return Promise.reject(new AppError("BAD_REQUEST", "请求标识已用于其他队列操作"));
		return existing.result;
	}
	const result = queueTransaction(ctx, async () => {
		if (ctx.recovery?.blocked)
			throw new AppError("SESSION_BUSY", "请先核对未知操作的实际结果，再继续或放弃本轮");
		sync(state, ctx.session.getSteeringMessages(), ctx.session.getFollowUpMessages());
		if (ctx.closing || ctx.session.isCompacting || ctx.session.isBashRunning)
			throw new AppError("SESSION_BUSY", "当前会话正在关闭、压缩或执行独立命令，请稍后重试");
		if (state.revision !== input.revision)
			throw new AppError("SESSION_BUSY", "队列已更新，请刷新后重试");
		const saved = {
			steer: [...state.queues.steer, ...state.recovery.steer],
			followUp: [...state.queues.followUp, ...state.recovery.followUp],
		};
		const selected = saved[input.behavior][input.index];
		if (!selected || selected.text !== input.expectedText)
			throw new AppError("SESSION_BUSY", "队列已更新，请刷新后重试");
		if ([...saved.steer, ...saved.followUp].some((item) => item.text.startsWith("/")))
			throw new AppError(
				"SESSION_BUSY",
				"队列包含以 / 开头的内容，无法保证原样发送，请保留输入并手动重发",
			);
		if (input.mode === "steer" && !ctx.session.isIdle) {
			if (recoveryCount(state)) {
				await recoverPending(ctx);
				throw new AppError("SESSION_BUSY", "队列已恢复，请刷新后重新选择切入消息");
			}
			await editSessionQueue(
				ctx,
				input.index,
				input.behavior,
				"steer",
				input.expectedText,
				true,
				input.revision,
			);
			return;
		}
		clearSessionQueue(ctx);
		state.recovery = saved;
		publishSnapshot(ctx);
		ctx.recovery?.cancel();
		ctx.interrupted = true;
		ctx.approvals.rejectAll("停止当前运行后发送队列消息");
		try {
			await ctx.session.abort();
			await ctx.recovery?.wait();
			if (ctx.closing || !ctx.session.isIdle)
				throw new AppError("SESSION_BUSY", "当前运行尚未停止，输入已保留");
			await new Promise<void>((resolve, reject) => {
				let accepted = false;
				let userStarted = false;
				let dispatched = false;
				let unsubscribe = () => {};
				const inputId = ctx.recovery?.beginInput(
					selected.text,
					selected.images,
					"followUp",
					true,
					selected.id,
				);
				const complete = () => {
					if (!accepted || !userStarted || dispatched) return;
					dispatched = true;
					state.recovery[input.behavior].splice(input.index, 1);
					state.revision++;
					state.incoming = undefined;
					state.incomingId = undefined;
					unsubscribe();
					publishSnapshot(ctx);
					resolve();
				};
				const fail = (error: unknown) => {
					unsubscribe();
					reject(error);
				};
				unsubscribe = ctx.session.subscribe((event) => {
					if (event.type === "message_start" && event.message.role === "user") {
						userStarted = true;
						complete();
					}
				});
				state.incoming = selected.images;
				state.incomingId = inputId ?? selected.id;
				void ctx.session
					.prompt(selected.text, {
						expandPromptTemplates: false,
						source: "rpc",
						streamingBehavior: "followUp",
						images: selected.images,
						preflightResult: (disposition) => {
							if (inputId) ctx.recovery?.acceptInput(inputId, disposition);
							if (disposition === "handled") {
								fail(new AppError("AGENT_ERROR", "消息未被SDK接受，输入已保留"));
								return;
							}
							accepted = true;
							complete();
						},
					})
					.then(() => {
						if (!dispatched) fail(new AppError("AGENT_ERROR", "SDK未确认接收，输入已保留"));
					})
					.catch((error: unknown) => {
						if (!dispatched) fail(error);
						else
							ctx.bus.publish({
								event: "error",
								data: { message: error instanceof Error ? error.message : "消息运行失败" },
							});
					});
			});
			await recoverPending(ctx);
		} catch (error) {
			state.incoming = undefined;
			state.incomingId = undefined;
			if (recoveryCount(state)) throw recoveryError(ctx, error);
			throw error;
		}
	});
	state.dispatches.set(input.requestId, { signature, result });
	if (state.dispatches.size > 64) state.dispatches.delete(state.dispatches.keys().next().value!);
	return result;
}
