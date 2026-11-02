/**
 * ask_user_question 工具 —— pi 无内置 AskUserQuestion，自注册自定义工具。
 *
 * execute 里经 ApprovalManager 挂起（Promise 式），答案作为工具结果回模型，
 * 天然持久化到 JSONL、翻译成 tool_result SSE。
 * 不用 ctx.ui.custom —— 其 factory 是 TUI 组件，Web 端无法执行（实施计划 §5.3）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arr, bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { type ApprovalManager, USER_APPROVAL_TIMEOUT_MS } from "./approval-manager";

const AskQuestionParams = obj({
	questions: arr(
		obj({
			question: str({ minLength: 1, description: "要向用户提出的问题" }),
			options: arr(
				obj({
					label: str({ description: "选项显示文本" }),
					description: opt(str({ description: "选项补充说明" })),
				}),
				{ description: "候选项列表" },
			),
			multiSelect: opt(bool({ description: "允许多选" })),
			allowCustom: opt(bool({ description: "允许自由输入（Other）" })),
			notes: opt(str({ description: "展示在问题下方的提示" })),
			required: opt(bool({ description: "是否必答，默认 true" })),
		}),
		{ minItems: 1, description: "要提出的问题列表，问题标题不可重复" },
	),
});

export function makeAskQuestionExt(approvals: ApprovalManager): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "ask_user_question",
			label: "Ask User",
			description:
				"向用户提出一个或多个选择题并等待回答。当你需要用户输入（澄清需求、二选一方案、收集偏好）才能继续时必须调用此工具，不要自行猜测。一次调用可含多个问题，用户会一次性作答。",
			parameters: AskQuestionParams,
			async execute(toolCallId, params, signal) {
				const { questions } = params as Static<typeof AskQuestionParams>;
				if (
					questions.length === 0 ||
					questions.some((q) => !q.question.trim()) ||
					new Set(questions.map((q) => q.question.trim())).size !== questions.length
				) {
					return {
						content: [{ type: "text", text: "问题列表不能为空，问题标题必须非空且不能重复。" }],
						details: { questions, answers: null },
						isError: true,
					};
				}
				// requestId 即 toolCallId：前端 dock 渲染卡片，任一 tab 提交后 settle
				const resolved = await approvals.create(
					"ask_question",
					toolCallId,
					{ questions },
					{
						signal,
						timeout: USER_APPROVAL_TIMEOUT_MS,
						onTimeout: () => ({
							action: "answer",
							reason: "等待用户回答超时，按系统默认交由模型自主决策",
							data: {
								answers: Object.fromEntries(questions.map((q) => [q.question, "请自主决策"])),
								timedOut: true,
							},
						}),
					},
				);
				const cancelled = resolved === undefined || resolved === null;
				// resolved = { questions, answers, annotations }，格式化为清爽文本给模型
				const answersMap = ((resolved as { answers?: Record<string, string> } | null)?.answers ??
					{}) as Record<string, string>;
				const annotationsMap = ((
					resolved as { annotations?: Record<string, { notes?: string }> } | null
				)?.annotations ?? {}) as Record<string, { notes?: string }>;
				const lines = questions.map((q, i) => {
					const answer = answersMap[q.question] ?? "（未回答）";
					const note = annotationsMap[q.question]?.notes;
					return `问题${i + 1}：${q.question} -> ${answer}${note ? `；备注：${note}` : ""}`;
				});
				const timedOut = !!(resolved as { timedOut?: boolean } | null)?.timedOut;
				const text = cancelled
					? "用户取消了本次提问，未提供答案。请基于现有信息继续或询问用户意图。"
					: `${timedOut ? "系统超时默认回答（用户五分钟未回答，请基于已有信息自主决策）" : "用户的回答"}：\n${lines.join("\n")}`;
				return {
					content: [{ type: "text", text }],
					details: {
						questions,
						answers: cancelled ? null : answersMap,
						...(timedOut ? { timedOut: true } : {}),
					},
					isError: cancelled,
				};
			},
		});
	};
}
