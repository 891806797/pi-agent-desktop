import { runToolCall } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RecoveryActionInput, RunIssue } from "@pi-agent/common";
import { AppError } from "@/core/app-error";
import {
	captureQueuedImages,
	clearSessionQueue,
	queueEntries,
	releaseRetainedInputs,
	retainSessionInputs,
} from "./queue-operations";
import type { RecoveryInput, RecoveryTool, RuntimeCheckpoint, RuntimeStore } from "./runtime-store";
import type { SessionContext } from "./session-registry";

type Message = Parameters<AgentSession["sessionManager"]["appendMessage"]>[0];
type Assistant = Extract<Message, { role: "assistant" }>;
type Call = Extract<Assistant["content"][number], { type: "toolCall" }>;
type Images = RecoveryInput["images"];

/** pi 保留执行上下文；此处只持有可重建的宿主检查点，不复刻 AgentLoop。 */
export class SessionRecovery {
	private state: RuntimeCheckpoint;
	private disabled = false;
	private controller = new AbortController();
	private task: Promise<void> = Promise.resolve();
	running = false;
	get issue(): RunIssue | null {
		return this.state.issue ?? null;
	}
	get blocked(): boolean {
		return this.state.issue?.kind === "uncertain";
	}
	restorePausedInputs(): void {
		this.commit();
		retainSessionInputs(this.ctx, this.state.inputs);
	}
	private setIssue(kind: RunIssue["kind"], message: string) {
		this.state.issue = {
			issueId: crypto.randomUUID(),
			attemptId: this.state.attemptId ?? crypto.randomUUID(),
			revision: (this.state.issue?.revision ?? 0) + 1,
			kind,
			message,
			createdAt: Date.now(),
			allowedActions: [kind === "recovery" ? "retryRecovery" : "continue", "abandon"],
		};
		this.save();
		this.ctx.bus.publish({ event: "run_issue", data: { issue: this.issue } });
	}
	constructor(
		private ctx: SessionContext,
		private store: RuntimeStore,
		saved?: RuntimeCheckpoint,
	) {
		this.state = saved ?? {
			version: 1,
			userId: ctx.userId,
			username: ctx.username,
			sessionId: ctx.sessionId,
			cwd: ctx.cwd,
			active: false,
			inputs: [],
			approvals: [],
			tools: [],
		};
		ctx.approvals.setPersistence({
			find: (id) => this.state.approvals.find((item) => item.request.requestId === id),
			write: (request, outcome) => {
				if (this.disabled) return;
				const previous = this.state.approvals;
				const previousIssue = this.state.issue;
				const index = this.state.approvals.findIndex(
					(item) => item.request.requestId === request.requestId,
				);
				const item = { request, ...(outcome ? { outcome } : {}) };
				this.state.approvals = [...previous];
				if (index < 0) this.state.approvals.push(item);
				else this.state.approvals[index] = item;
				try {
					if (
						request.requestId.startsWith("restart-confirm:") &&
						!outcome &&
						this.state.issue?.kind !== "uncertain"
					) {
						this.state.issue = {
							issueId: request.requestId,
							attemptId: this.state.attemptId ?? crypto.randomUUID(),
							revision: 1,
							kind: "uncertain",
							message:
								"有工具在重启前已经开始，执行结果未知。请检查实际状态后继续，系统不会自动重做。",
							createdAt: request.createdAt,
							allowedActions: ["continue", "abandon"],
						};
					}
					this.save();
					if (previousIssue !== this.state.issue)
						this.ctx.bus.publish({ event: "run_issue", data: { issue: this.issue } });
				} catch (error) {
					this.state.approvals = previous;
					this.state.issue = previousIssue;
					throw error;
				}
			},
		});
	}

	private save(): void {
		if (this.disabled) return;
		if (
			this.state.active ||
			this.state.issue ||
			this.state.intent ||
			this.state.inputs.length ||
			this.state.approvals.some((item) => !item.outcome)
		)
			this.store.write(this.state);
		else this.store.remove(this.state.userId, this.state.sessionId);
	}

	beginInput(
		text: string,
		images: Images,
		behavior: "steer" | "followUp",
		prepared = false,
		id: string = crypto.randomUUID(),
	): string {
		const input: RecoveryInput = { id, text, images, behavior, prepared, phase: "pending" };
		if (this.state.issue && !this.blocked) {
			this.state.issue = undefined;
			this.ctx.bus.publish({ event: "run_issue", data: { issue: null } });
		}
		this.state.inputs = this.state.inputs.filter((item) => item.id !== id);
		this.state.inputs.push(input);
		this.save();
		return id;
	}
	acceptInput(id: string, disposition: string): void {
		const item = this.state.inputs.find((entry) => entry.id === id);
		if (item && disposition === "started") item.phase = "direct";
		if (disposition === "handled")
			this.state.inputs = this.state.inputs.filter((entry) => entry.id !== id);
		this.syncQueues();
		this.save();
	}
	rejectInput(id: string): void {
		this.state.inputs = this.state.inputs.filter((entry) => entry.id !== id);
		this.save();
	}
	clearQueuedInputs(): void {
		this.state.inputs = this.state.inputs.filter((item) => item.phase === "direct");
		this.save();
	}

	private syncQueues(): void {
		const queue = queueEntries(this.ctx);
		if (queue.clearing) return;
		const ids = new Set([...queue.steer, ...queue.followUp].map((item) => item.id));
		for (const input of this.state.inputs)
			if (input.phase === "queued" && !ids.has(input.id)) input.phase = "delivering";
		for (const behavior of ["steer", "followUp"] as const)
			queue[behavior].forEach((item, position) => {
				const input: RecoveryInput = {
					...item,
					prepared: true,
					phase: "queued",
					behavior,
					position,
				};
				const index = this.state.inputs.findIndex((entry) => entry.id === item.id);
				if (index < 0) this.state.inputs.push(input);
				else this.state.inputs[index] = input;
			});
	}
	queueChanged(): void {
		if (!this.disabled) {
			this.syncQueues();
			this.save();
		}
	}

	private commit(): void {
		if (this.disabled) return;
		const users = this.ctx.session.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
			);
		this.state.inputs = this.state.inputs.filter(
			(input) =>
				!input.expected ||
				!users.filter((message) => message.timestamp === input.expected!.timestamp)[
					input.expected.ordinal
				],
		);
		const completed = new Set(
			this.ctx.session.messages.flatMap((message) =>
				message.role === "toolResult" ? [message.toolCallId] : [],
			),
		);
		this.state.tools = this.state.tools.filter((tool) => !completed.has(tool.toolCallId));
		this.state.approvals = this.state.approvals.filter(
			(item) => !completed.has(item.request.requestId),
		);
		this.save();
	}
	private commitLater(): void {
		queueMicrotask(() => {
			try {
				this.commit();
			} catch (error) {
				this.ctx.bus.publish({
					event: "error",
					data: {
						message: `运行检查点提交失败，已保留上次记录：${error instanceof Error ? error.message : String(error)}`,
					},
				});
			}
		});
	}

	onEvent(event: AgentSessionEvent): void {
		if (this.disabled) return;
		if (event.type === "agent_start") {
			this.state.attemptId = this.state.intent?.attemptId ?? crypto.randomUUID();
			this.state.active = true;
			this.save();
		}
		if (event.type === "queue_update") {
			this.syncQueues();
			this.save();
		}
		if (event.type === "message_start" && event.message.role === "user") {
			const message = event.message;
			const eligible = this.state.inputs.filter((input) => !input.expected);
			const item =
				eligible.find((input) => input.phase === "direct") ??
				eligible.find((input) => input.phase === "delivering") ??
				eligible.find((input) => input.phase === "pending");
			if (item) {
				item.expected = {
					timestamp: message.timestamp,
					ordinal: this.ctx.session.sessionManager
						.getEntries()
						.filter(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.timestamp === message.timestamp,
						).length,
				};
				item.text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("");
				item.images = Array.isArray(message.content)
					? message.content.filter((part) => part.type === "image")
					: undefined;
				item.prepared = true;
				this.save();
			}
		}
		if (event.type === "tool_execution_start") {
			const tool: RecoveryTool = {
				toolCallId: event.toolCallId,
				name: event.toolName,
				input: event.args as Record<string, unknown>,
				phase: "started",
				parentToolCallId: event.parentToolCallId,
			};
			this.state.tools = [
				...this.state.tools.filter((item) => item.toolCallId !== tool.toolCallId),
				tool,
			];
			this.save();
		}
		if (event.type === "tool_execution_end") {
			const tool = this.state.tools.find((item) => item.toolCallId === event.toolCallId);
			if (tool) {
				Object.assign(tool, {
					phase: "completed",
					result: event.result,
					isError: event.isError,
					durationMs: event.durationMs,
				});
				this.save();
			}
		}
		if (event.type === "message_end") this.commitLater();
		if (event.type === "agent_settled") {
			this.state.active = false;
			const last = this.ctx.session.messages.findLast((message) => message.role === "assistant");
			if (!this.ctx.interrupted && last?.role === "assistant" && last.stopReason === "error")
				this.setIssue("model", last.errorMessage ?? "模型请求未完成，请检查原因后继续。");
			if (this.state.intent) this.finishAttempt(this.state.issue ? "failed" : "completed");
			this.commitLater();
		}
	}

	start(): void {
		if (this.running) return;
		if (this.controller.signal.aborted) this.controller = new AbortController();
		this.running = true;
		this.task = this.restore()
			.catch((error) => {
				if (!this.disabled && !this.controller.signal.aborted) {
					try {
						this.state.active = false;
						this.setIssue("recovery", error instanceof Error ? error.message : String(error));
						this.finishAttempt("failed");
						this.restorePausedInputs();
					} catch (saveError) {
						console.error("[recovery issue]", saveError);
					}
					this.ctx.bus.publish({
						event: "error",
						data: {
							message: `运行恢复未完成：${error instanceof Error ? error.message : String(error)}`,
						},
					});
					this.ctx.bus.publish({ event: "status", data: { status: "error" } });
				}
			})
			.finally(() => {
				this.running = false;
				if (!this.disabled && !this.ctx.closing)
					this.ctx.bus.publish({
						event: "status",
						data: { status: this.issue ? "error" : this.ctx.status },
					});
			});
	}

	async applyAction(input: RecoveryActionInput): Promise<{ accepted: true }> {
		const signature = JSON.stringify([
			this.ctx.sessionId,
			input.issueId,
			input.expectedRevision,
			input.action,
		]);
		const previous = this.store.action(this.ctx.userId, input.actionId);
		if (previous !== undefined) {
			if (previous !== signature) throw new AppError("BAD_REQUEST", "操作标识已用于其他恢复动作");
			return { accepted: true };
		}
		const issue = this.state.issue;
		if (
			!issue ||
			issue.issueId !== input.issueId ||
			issue.revision !== input.expectedRevision ||
			!issue.allowedActions.includes(input.action)
		)
			throw new AppError("SESSION_BUSY", "恢复状态已变化，请刷新后重试");
		if (this.ctx.closing || (!this.ctx.session.isIdle && !this.blocked))
			throw new AppError("SESSION_BUSY");
		const before = structuredClone(this.state);
		this.state.issue = undefined;
		this.state.active = input.action !== "abandon";
		this.state.intent =
			input.action === "abandon"
				? undefined
				: { actionId: input.actionId, attemptId: crypto.randomUUID(), issueId: input.issueId };
		if (input.action === "abandon") {
			this.state.inputs = [];
			for (const saved of this.state.approvals)
				if (!saved.outcome) saved.outcome = { action: "cancelled", reason: "已放弃本轮" };
		} else if (issue.kind === "uncertain" && this.ctx.approvals.has(issue.issueId)) {
			const saved = this.state.approvals.find((item) => item.request.requestId === issue.issueId);
			if (saved) saved.outcome = { action: "answer", data: true };
		} else
			this.state.approvals = this.state.approvals.filter(
				(item) => !item.request.requestId.startsWith("restart-confirm:"),
			);
		try {
			this.store.claimAction(this.state, input.actionId, signature);
		} catch (error) {
			this.state = before;
			throw error;
		}
		this.ctx.bus.publish({ event: "run_issue", data: { issue: null } });
		if (input.action === "abandon") {
			this.cancel();
			this.ctx.interrupted = true;
			this.ctx.approvals.rejectAll("已放弃本轮");
			clearSessionQueue(this.ctx);
			await this.ctx.session.abort();
			await this.wait();
			this.ctx.bus.publish({ event: "status", data: { status: "idle" } });
		} else if (issue.kind === "uncertain" && this.ctx.approvals.has(issue.issueId)) {
			this.ctx.approvals.settle(issue.issueId, { action: "answer", data: true });
		} else {
			this.start();
		}
		return { accepted: true };
	}
	private finishAttempt(status: "completed" | "failed") {
		if (!this.state.intent) return;
		this.ctx.session.sessionManager.appendCustomEntry("web_run_attempt", {
			...this.state.intent,
			status,
		});
		this.state.intent = undefined;
		this.save();
	}
	private emit(event: AgentSessionEvent): void {
		this.onEvent(event);
		for (const translated of this.ctx.translator.translate(event)) this.ctx.bus.publish(translated);
	}

	private appendResult(
		call: Call,
		result: NonNullable<RecoveryTool["result"]>,
		isError = false,
	): void {
		const message: Extract<Message, { role: "toolResult" }> = {
			...result,
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			isError,
			timestamp: Date.now(),
		};
		this.ctx.session.sessionManager.appendMessage(message);
		this.ctx.session.agent.state.messages = [...this.ctx.session.messages, message];
		this.emit({
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: call.name,
			result,
			isError,
		});
		this.commit();
	}

	private async execute(assistant: Assistant, call: Call): Promise<void> {
		this.emit({
			type: "tool_execution_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
		});
		const agent = this.ctx.session.agent;
		const outcome = await runToolCall(call, {
			assistantMessage: assistant,
			tools: agent.state.tools,
			context: {
				messages: [...this.ctx.session.messages],
				tools: agent.state.tools,
			},
			beforeToolCall: agent.beforeToolCall,
			afterToolCall: agent.afterToolCall,
			signal: this.controller.signal,
			onUpdate: (partialResult) =>
				this.emit({
					type: "tool_execution_update",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
					partialResult,
				}),
		});
		if (!this.disabled) this.appendResult(call, outcome.result, outcome.isError);
	}

	private async restore(): Promise<void> {
		releaseRetainedInputs(this.ctx);
		this.commit();
		if (this.state.intent) {
			const intent = this.state.intent;
			const entries = this.ctx.session.sessionManager.getEntries();
			const marker = entries.findLast(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "web_run_attempt" &&
					(entry.data as { attemptId?: string })?.attemptId === intent.attemptId,
			);
			if (marker?.type === "custom" && (marker.data as { status?: string }).status !== "started") {
				this.state.intent = undefined;
				this.state.active = false;
				this.save();
				if (this.state.issue) {
					this.restorePausedInputs();
					this.ctx.bus.publish({ event: "run_issue", data: { issue: this.issue } });
					this.ctx.bus.publish({ event: "status", data: { status: "error" } });
					return;
				}
				if (!this.state.inputs.length) return;
				this.state.inputs[0]!.phase = "pending";
			} else if (marker) {
				const after = entries.slice(entries.indexOf(marker) + 1);
				const last = after.findLast(
					(entry) => entry.type === "message" && entry.message.role === "assistant",
				);
				if (
					last?.type === "message" &&
					last.message.role === "assistant" &&
					last.message.stopReason === "stop" &&
					after.findLast((entry) => entry.type === "message") === last &&
					!last.message.content.some((part) => part.type === "toolCall")
				) {
					this.state.active = false;
					this.finishAttempt("completed");
					if (!this.state.inputs.length) return;
					this.state.inputs[0]!.phase = "pending";
				}
			} else
				this.ctx.session.sessionManager.appendCustomEntry("web_run_attempt", {
					...intent,
					status: "started",
				});
		}
		this.ctx.bus.publish({ event: "status", data: { status: "thinking" } });
		const pending: Array<{ assistant: Assistant; call: Call; tool?: RecoveryTool }> = [];
		const messages = this.ctx.session.messages;
		messages.forEach((message, index) => {
			if (message.role !== "assistant") return;
			const next = messages.findIndex(
				(item, position) => position > index && item.role === "assistant",
			);
			const results = messages.slice(index + 1, next < 0 ? undefined : next);
			for (const call of message.content)
				if (
					call.type === "toolCall" &&
					!results.some((result) => result.role === "toolResult" && result.toolCallId === call.id)
				)
					if (["length", "error", "aborted"].includes(message.stopReason)) {
						this.appendResult(
							call,
							{
								content: [
									{
										type: "text",
										text: `工具未执行：模型响应以 ${message.stopReason} 结束，参数可能不完整；如仍需操作，请重新生成完整调用。`,
									},
								],
								details: {},
							},
							true,
						);
					} else
						pending.push({
							assistant: message,
							call,
							tool: this.state.tools.find((item) => item.toolCallId === call.id),
						});
		});
		const unknown = pending.filter(
			(item) =>
				item.tool?.phase === "started" &&
				!this.state.approvals.some(
					(entry) => entry.request.requestId === item.call.id && !entry.outcome,
				),
		);
		const uncertainIds = new Set(unknown.map((item) => item.call.id));
		let interruptedDialog = false;
		for (const saved of this.state.approvals) {
			if (
				saved.outcome ||
				!saved.request.kind.startsWith("ui_") ||
				saved.request.requestId.startsWith("restart-confirm:")
			)
				continue;
			saved.outcome = { action: "cancelled", reason: "进程重启后无法安全恢复原扩展调用栈" };
			if (!saved.request.origin || !uncertainIds.has(saved.request.origin.toolCallId))
				interruptedDialog = true;
		}
		if (interruptedDialog && !unknown.length) {
			this.state.active = false;
			this.setIssue(
				"recovery",
				"上次扩展交互的调用方已中断，无法恢复原对话框。可以基于已保存的上下文继续，或放弃本轮。",
			);
			this.ctx.bus.publish({ event: "status", data: { status: "error" } });
			return;
		}
		const confirmationId = `restart-confirm:${this.ctx.sessionId}`;
		const previous = this.state.approvals.find((item) => item.request.requestId === confirmationId);
		if (unknown.length || previous) {
			const payload = previous?.request.payload ?? {
				title: "重启恢复确认",
				message: `以下工具在重启前已开始，但结果未知；不会自动重跑。请检查实际状态后选择“是”继续，选择“否”或取消保持停止。\n${unknown.map((item) => `${item.call.name}: ${JSON.stringify(item.call.arguments)}`).join("\n")}`,
			};
			const confirmation = this.ctx.approvals.create("ui_confirm", confirmationId, payload);
			for (const { call } of unknown)
				this.appendResult(
					call,
					{
						content: [
							{
								type: "text",
								text: "进程重启中断此调用，执行结果未知；可能已经产生实际修改，继续前必须核对实际状态，不能直接重复执行。",
							},
						],
						details: { restartUncertain: true },
					},
					true,
				);
			if (!(await confirmation) || this.controller.signal.aborted) {
				this.state.active = false;
				retainSessionInputs(this.ctx, this.state.inputs);
				this.save();
				this.ctx.bus.publish({ event: "status", data: { status: "idle" } });
				return;
			}
			this.state.issue = undefined;
			this.ctx.bus.publish({ event: "run_issue", data: { issue: null } });
			if (this.state.intent)
				this.ctx.session.sessionManager.appendCustomEntry("web_run_attempt", {
					...this.state.intent,
					status: "started",
				});
		}
		this.state.active = true;
		this.save();
		for (const item of pending) {
			if (this.controller.signal.aborted) return;
			if (unknown.includes(item)) continue;
			if (item.tool?.phase === "completed" && item.tool.result)
				this.appendResult(item.call, item.tool.result, item.tool.isError);
			else await this.execute(item.assistant, item.call);
		}
		if (this.controller.signal.aborted) return;
		const first = this.state.inputs.find(
			(item) => item.phase === "direct" || item.phase === "pending",
		);
		const unsubscribe = this.ctx.session.subscribe((event) => {
			if (
				first
					? event.type !== "message_start" || event.message.role !== "user"
					: event.type !== "agent_start"
			)
				return;
			unsubscribe();
			this.running = false;
			void this.restoreQueues(first?.id);
		});
		try {
			if (first)
				await captureQueuedImages(
					this.ctx,
					first.images,
					() =>
						this.ctx.session.prompt(first.text, {
							source: "rpc",
							expandPromptTemplates: !first.prepared,
							images: first.images,
							preflightResult: (disposition) => this.acceptInput(first.id, disposition),
						}),
					first.id,
				);
			else
				await this.ctx.session.sendCustomMessage(
					{
						customType: "web_run_recovery",
						content:
							"继续上次未完成的任务。请基于已有用户需求、已完成的工具结果继续；已完成的操作不要重复。对执行结果未知的工具先检查实际状态；如果任务已完成，简短确认即可，不要增加新任务。",
						display: true,
					},
					{ triggerTurn: true },
				);
		} finally {
			unsubscribe();
		}
	}

	private async restoreQueues(exclude?: string): Promise<void> {
		const live = queueEntries(this.ctx);
		const ids = new Set([...live.steer, ...live.followUp].map((item) => item.id));
		const inputs = [...this.state.inputs]
			.filter((item) => item.id !== exclude && !ids.has(item.id))
			.sort((a, b) =>
				a.behavior === b.behavior
					? (a.position ?? 0) - (b.position ?? 0)
					: a.behavior === "steer"
						? -1
						: 1,
			);
		for (const input of inputs) {
			if (this.controller.signal.aborted || this.disabled) return;
			try {
				await captureQueuedImages(
					this.ctx,
					input.images,
					() =>
						new Promise<void>((resolve, reject) => {
							void this.ctx.session
								.prompt(input.text, {
									source: "rpc",
									expandPromptTemplates: !input.prepared,
									images: input.images,
									streamingBehavior: input.behavior,
									preflightResult: (disposition) => {
										this.acceptInput(input.id, disposition);
										resolve();
									},
								})
								.catch(reject);
						}),
					input.id,
				);
			} catch (error) {
				retainSessionInputs(this.ctx, [input]);
				this.ctx.bus.publish({
					event: "error",
					data: { message: `排队输入恢复失败，已保留检查点：${String(error)}` },
				});
			}
		}
	}

	cancel(): void {
		this.controller.abort();
		this.state.active = false;
		this.state.inputs = [];
		this.state.issue = undefined;
		this.state.intent = undefined;
		this.ctx.bus.publish({ event: "run_issue", data: { issue: null } });
		this.save();
	}
	wait(): Promise<void> {
		return this.task;
	}
	remove(): void {
		this.disabled = true;
		this.store.remove(this.state.userId, this.state.sessionId);
	}
	suspend(): void {
		this.syncQueues();
		this.save();
		this.disabled = true;
		this.ctx.approvals.suspend();
		this.controller.abort();
		this.ctx.session.dispose();
	}
}
