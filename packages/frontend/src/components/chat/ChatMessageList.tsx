import type { AgentStatus, AssistantBlock, ChatMessage } from "@pi-agent/common";
import { cacheHitRate } from "@pi-agent/common";
import { ArchiveIcon, ArrowDownIcon, ChevronRightIcon, Loader } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatScroll } from "@/hooks/useChatScroll";
import type { Attachment, ChatAgentApi } from "@/lib/agent-types";
import { beijingFormat, formatTokens, messageTime } from "@/lib/format";
import { useChatStore } from "@/stores/chat";
import { ChatInput } from "./chat-input";
import { ExtensionPanel } from "./ExtensionPanel";
import { Markdown } from "./Markdown";
import { PermissionRequest } from "./PermissionRequest";
import { RecoveryNotice } from "./RecoveryNotice";
import { ToolResultRenderer } from "./tool-results";
import { GUTTER, GUTTER_TEXT } from "./tool-results/shared";

interface ChatMessageListProps {
	agent: ChatAgentApi;
}

export function ChatMessageList({ agent }: ChatMessageListProps): React.JSX.Element {
	const issue = useChatStore((state) => state.issue);
	const ui = useChatStore((state) => state.ui);

	const {
		messages,
		isRunning,
		isCompacting,
		isSwitchingSession,
		status,
		lastError,
		approvalRequests,
		commands,
		sendMessage,
		interruptRun,
		approve,
	} = agent;
	const hasMessages = messages.length > 0;

	const { listRef, contentRef, following, resume } = useChatScroll(
		`${agent.projectId}:${agent.sessionId}`,
		isSwitchingSession,
	);
	const handleSend = useCallback(
		(
			text: string,
			attachments?: Attachment[],
			behavior?: "steer" | "followUp",
		): Promise<boolean> => {
			resume();
			return sendMessage(text, attachments, behavior);
		},
		[sendMessage, resume],
	);

	return (
		<div className="h-full min-h-0 flex flex-col bg-[var(--bg-base)]">
			<div className="flex-1 min-h-0 relative">
				<section
					ref={listRef}
					style={{ overflowAnchor: "none" }}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: 可聚焦的滚动区域支持原生键盘滚动。
					tabIndex={0}
					aria-label="聊天消息"
					className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
				>
					<div
						ref={contentRef}
						className={`transition-opacity duration-200 ${isSwitchingSession ? "opacity-0" : "opacity-100"}`}
					>
						{hasMessages ? (
							<div className="flex flex-col">
								{messages.map((message, i) => (
									<MessageItem
										key={message.id}
										message={message}
										isThinkingActive={
											status === "thinking" &&
											i === messages.length - 1 &&
											message.type === "assistant"
										}
										isStreaming={
											(status === "thinking" || status === "responding") &&
											i === messages.length - 1 &&
											message.type === "assistant"
										}
									/>
								))}
							</div>
						) : (
							<EmptyState />
						)}
					</div>
				</section>
				{/* loading 覆盖层：absolute 不随滚动，opacity crossfade 淡入淡出 */}
				<div
					className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--text-faint)] transition-opacity duration-200 ${
						isSwitchingSession ? "opacity-100" : "opacity-0 pointer-events-none"
					}`}
				>
					<Loader className="size-5 animate-spin" />
					<span className="text-[12px]">加载会话…</span>
				</div>
				{hasMessages && !isSwitchingSession && (
					<button
						type="button"
						onClick={resume}
						className={[
							"absolute bottom-3 right-4 size-9 flex items-center justify-center rounded-full z-10",
							"bg-[var(--bg-base)] border border-[var(--border-base)] shadow-[var(--elevation-raised)]",
							"text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)]",
							"transition-all duration-200",
							following ? "opacity-0 pointer-events-none translate-y-2 scale-95" : "opacity-100",
						].join(" ")}
						title="回到底部"
					>
						<ArrowDownIcon className="size-4" />
					</button>
				)}
			</div>

			{approvalRequests.length > 0 && (
				<div
					className={
						approvalRequests.some((request) => request.kind === "ask_question")
							? "flex min-h-0 max-h-[70%] shrink-0 flex-col overflow-hidden"
							: "shrink-0 max-h-[60vh] overflow-auto"
					}
				>
					{approvalRequests
						.filter((r) => !(issue?.kind === "uncertain" && r.requestId === issue.issueId))
						.map((r) => (
							<PermissionRequest
								key={r.requestId}
								request={r}
								onApprove={(action, data) => approve(r.requestId, action, data)}
							/>
						))}
				</div>
			)}

			<StatusBar
				status={status}
				isCompacting={isCompacting}
				workingVisible={ui.workingVisible}
				workingMessage={ui.workingMessage}
			/>
			<RecoveryNotice key={agent.sessionId} issue={issue} />
			<ExtensionPanel key={`${agent.sessionId}:above`} ui={ui} placement="aboveEditor" />

			{lastError && (
				<p
					role="alert"
					className="max-h-24 overflow-auto whitespace-pre-wrap break-words px-4 text-xs text-[var(--danger-text)]"
				>
					{lastError}
				</p>
			)}
			<ChatInput
				isRunning={isRunning}
				isSwitchingSession={isSwitchingSession}
				commands={commands}
				projectId={agent.projectId}
				runMode={agent.runMode}
				runModeLabel={agent.runModeLabel}
				onSelectRunMode={(m) => {
					void agent.selectRunMode(m).catch(() => {});
				}}
				onSend={handleSend}
				onInterrupt={interruptRun}
			/>
			<ExtensionPanel key={`${agent.sessionId}:below`} ui={ui} placement="belowEditor" />
		</div>
	);
}

function EmptyState(): React.JSX.Element {
	return (
		<div className="flex flex-1 items-center justify-center text-[var(--text-faint)] text-sm">
			开始新会话…
		</div>
	);
}

const MessageItem = memo(function MessageItem({
	message,
	isThinkingActive,
	isStreaming,
}: {
	message: ChatMessage;
	isThinkingActive?: boolean;
	isStreaming?: boolean;
}): React.JSX.Element {
	switch (message.type) {
		case "user":
			return <UserBubble message={message} />;
		case "assistant":
			return (
				<AssistantBubble
					message={message}
					isThinkingActive={isThinkingActive}
					isStreaming={isStreaming}
				/>
			);
		case "system":
			return <SystemBubble message={message} />;
		case "compaction":
			return <CompactionDivider message={message} />;
	}
});

export const UserBubble = memo(function UserBubble({
	message,
}: {
	message: Extract<ChatMessage, { type: "user" }>;
}): React.JSX.Element {
	return (
		<div className="flex justify-end items-start gap-1.5 px-4 py-1">
			<div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--bg-layer-02)] px-3.5 py-2">
				<p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-base)]">
					{message.content}
				</p>
				{message.images?.map((image, index) => (
					<img
						key={`${index}-${image.mimeType}`}
						src={`data:${image.mimeType};base64,${image.data}`}
						alt="用户发送的图片"
						className="mt-2 max-h-80 max-w-full rounded-lg object-contain"
						loading="lazy"
					/>
				))}
			</div>
		</div>
	);
});

// ===== AI 消息 =====

// memo：assistant 消息最重（markdown/代码块/工具结果），历史消息引用稳定可浅比较跳过
// 不用 content-visibility:auto：flex 滚动容器内离屏消息首帧按 intrinsic-size 撑高列表，裁出输入框
export const AssistantBubble = memo(function AssistantBubble({
	message,
	isThinkingActive,
	isStreaming,
}: {
	message: Extract<ChatMessage, { type: "assistant" }>;
	isThinkingActive?: boolean;
	isStreaming?: boolean;
}): React.JSX.Element {
	const hitRate = message.usage ? cacheHitRate(message.usage) : null;
	return (
		<div className="flex flex-col px-4 py-1.5">
			{message.blocks.map((block, i) => (
				<ContentBlockView
					key={block.kind === "toolCall" ? block.toolCallId : i}
					block={block}
					isThinkingActive={isThinkingActive && i === message.blocks.length - 1}
					isStreaming={isStreaming && i === message.blocks.length - 1}
				/>
			))}
			{message.errorMessage && (
				<p
					role="alert"
					className="whitespace-pre-wrap break-words px-4 text-xs text-[var(--danger-text)]"
				>
					{message.errorMessage}
				</p>
			)}
			{message.stopReason === "aborted" && (
				<span className="text-[11px] text-[var(--text-faint)] select-none">（已中断）</span>
			)}
			{message.stopReason === "length" && (
				<p role="status" className="mt-2 text-xs text-[var(--warning-text)]">
					达到输出长度限制，本次回复尚未完成；可要求助手继续。
				</p>
			)}
			{message.usage &&
				message.usage.inputTokens +
					message.usage.outputTokens +
					message.usage.cacheReadTokens +
					message.usage.cacheCreationTokens >
					0 && (
					<p
						className="mt-2 text-xs text-[var(--text-muted)]"
						title="本次响应用量；缓存命中率 = 缓存读取 / 全部输入 Token"
					>
						本次响应 · 输入 {formatTokens(message.usage.inputTokens)} · 输出{" "}
						{formatTokens(message.usage.outputTokens)}
						{` · 缓存命中率 ${hitRate === null ? "—" : `${hitRate.toFixed(1)}%`} · `}
						<time
							dateTime={new Date(message.createdAt).toISOString()}
							title={`${beijingFormat(message.createdAt)} 北京时间`}
							className="whitespace-nowrap tabular-nums"
						>
							{messageTime(message.createdAt)}
						</time>
					</p>
				)}
		</div>
	);
});

// memo：content 数组中未变化的 block 引用稳定（流式只重建末尾正在变化的 block）
const ContentBlockView = memo(function ContentBlockView({
	block,
	isThinkingActive,
	isStreaming,
}: {
	block: AssistantBlock;
	isThinkingActive?: boolean;
	isStreaming?: boolean;
}): React.JSX.Element | null {
	if (block.kind === "text") {
		return <AssistantContent text={block.text} isStreaming={!!isStreaming} />;
	}
	if (block.kind === "thinking") {
		// 空思考内容不渲染
		if (!block.thinking) return null;
		return <ThinkingBlock text={block.thinking} isStreaming={!!isThinkingActive} />;
	}
	return <ToolCallBlock block={block} />;
});

// 布局：● 在 gutter，工具名在内容区；CSS border-l-2 竖线对齐工具名正下方

/* ─── 底层 Row ─── */

function Row({
	gutter,
	children,
	onClick,
	clickable,
	expanded,
}: {
	gutter: React.ReactNode;
	children: React.ReactNode;
	onClick?: () => void;
	clickable?: boolean;
	expanded?: boolean;
}): React.JSX.Element {
	const marker = (
		<span className={`${GUTTER} ${GUTTER_TEXT} leading-relaxed`} aria-hidden>
			{gutter}
		</span>
	);
	if (clickable) {
		return (
			<button
				type="button"
				onClick={onClick}
				aria-expanded={expanded}
				className="flex w-full min-h-7 items-center rounded text-left hover:bg-[var(--bg-layer-01)] focus-visible:outline-2 focus-visible:outline-[var(--text-base)]"
			>
				{marker}
				<span className="min-w-0 flex-1">{children}</span>
			</button>
		);
	}
	return (
		<div className="flex flex-row items-start">
			{marker}
			<div className="flex-1 min-w-0">{children}</div>
		</div>
	);
}

/* ─── 文本 ─── */

const AssistantContent = memo(function AssistantContent({
	text,
	isStreaming,
}: {
	text: string;
	isStreaming?: boolean;
}): React.JSX.Element {
	return (
		<Row gutter="">
			<Markdown isStreaming={isStreaming}>{text}</Markdown>
		</Row>
	);
});

/* ─── Thinking ─── */

const ThinkingBlock = memo(function ThinkingBlock({
	text,
	isStreaming,
}: {
	text: string;
	isStreaming: boolean;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const prevStreamingRef = useRef(false);

	// isStreaming 从 false→true 时自动展开；从 true→false 时自动折叠
	useEffect(() => {
		if (prevStreamingRef.current !== isStreaming) {
			prevStreamingRef.current = isStreaming;
			setOpen(isStreaming);
		}
	}, [isStreaming]);

	// 展开时自动滚动到底部（跟随新内容）
	// biome-ignore lint/correctness/useExhaustiveDependencies: text 为流式跟随滚动触发器
	useEffect(() => {
		if (open && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [open, text]);

	return (
		<div className="py-0.5">
			<Row gutter="" onClick={() => setOpen(!open)} clickable expanded={open}>
				<span className="text-xs text-[var(--text-muted)] inline-flex items-center gap-1.5">
					<ChevronRightIcon
						className={`size-2.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
					/>
					思考过程
				</span>
			</Row>
			{open && (
				<div
					ref={scrollRef}
					className="mt-1 ml-5 bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)] max-h-[240px] overflow-auto"
				>
					<Markdown dimColor isStreaming={isStreaming}>
						{text}
					</Markdown>
				</div>
			)}
		</div>
	);
});

function getDisplayName(name: string, input: Record<string, unknown>): string {
	const detail = input.path ?? input.command ?? input.pattern ?? input.query ?? input.url;
	return typeof detail === "string" && detail
		? `${name}(${detail.split("\n")[0]!.slice(0, 60)})`
		: name;
}

const ToolCallBlock = memo(function ToolCallBlock({
	block,
}: {
	block: Extract<AssistantBlock, { kind: "toolCall" }>;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const input = useMemo<Record<string, unknown>>(() => {
		try {
			const value: unknown = JSON.parse(block.argsText);
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}, [block.argsText]);
	const { name, status, result } = block;
	const images = result?.images;
	const displayName = getDisplayName(name, input);

	return (
		<div className="py-0.5">
			<Row gutter="" onClick={() => setOpen(!open)} clickable expanded={open}>
				<span className="text-xs text-[var(--text-muted)] inline-flex items-center gap-1.5 select-none min-w-0 overflow-hidden whitespace-nowrap">
					<ChevronRightIcon
						className={`size-2.5 transition-transform duration-150 shrink-0 ${open ? "rotate-90" : ""}`}
					/>
					<code className="text-xs font-mono text-[var(--text-muted)] truncate min-w-0">
						{displayName}{" "}
						{status === "streaming" || status === "running"
							? " · 运行中"
							: status === "cancelled"
								? " · 已取消"
								: status === "error"
									? " · 失败"
									: ""}
					</code>
				</span>
			</Row>

			{open && (
				<pre className="mt-1 ml-5 text-[11px] text-[var(--text-faint)] whitespace-pre-wrap font-mono bg-[var(--bg-layer-01)] p-2 rounded max-h-[120px] overflow-auto border border-[var(--border-muted)]">
					{block.argsText}
				</pre>
			)}

			{images?.map((image, i) => (
				<img
					key={`${i}-${image.mimeType}`}
					src={`data:${image.mimeType};base64,${image.data}`}
					alt="工具输出图片"
					className="max-w-full rounded ml-5"
				/>
			))}
			{result !== undefined && (
				<ToolResultRenderer content={result.content} error={result.error || status === "error"} />
			)}
			{result?.toolUseResult !== undefined && (
				<details className="ml-5 mt-1 text-xs text-[var(--text-muted)]">
					<summary className="cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-[var(--text-base)]">
						工具详情{result.durationMs !== undefined ? ` · ${result.durationMs} ms` : ""}
					</summary>
					<pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-muted)] bg-[var(--bg-layer-01)] p-3 text-xs">
						{typeof result.toolUseResult === "object" &&
						result.toolUseResult !== null &&
						"diff" in result.toolUseResult &&
						typeof result.toolUseResult.diff === "string"
							? result.toolUseResult.diff
							: JSON.stringify(result.toolUseResult, null, 2)}
					</pre>
				</details>
			)}
		</div>
	);
});

// ===== System 消息 =====

const SystemBubble = memo(function SystemBubble({
	message,
}: {
	message: Extract<ChatMessage, { type: "system" }>;
}): React.JSX.Element | null {
	if (!message.content) return null;

	return (
		<div className="flex justify-center px-4 py-1">
			<span className="whitespace-pre-wrap break-words text-xs text-[var(--text-muted)] text-center italic">
				{message.content}
			</span>
		</div>
	);
});

// ===== 上下文压缩边界 =====
// SDK 完成 compaction 后插入，标记此处之上的早期消息已被摘要替换

export const CompactionDivider = memo(function CompactionDivider({
	message,
}: {
	message: Extract<ChatMessage, { type: "compaction" }>;
}): React.JSX.Element {
	return (
		<div className="px-4 py-2">
			<div className="flex items-center gap-2 select-none">
				<span className="flex-1 h-px bg-[var(--border-muted)]" />
				<span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-faint)] shrink-0">
					<ArchiveIcon className="size-3" />
					会话压缩
					{message.tokensAfter !== undefined && (
						<span>· 压缩后 {formatTokens(message.tokensAfter)}</span>
					)}
					{(message.tokensBefore ?? 0) > 0 && (
						<span className="tabular-nums">· 压缩前 {formatTokens(message.tokensBefore ?? 0)}</span>
					)}
				</span>
				<span className="flex-1 h-px bg-[var(--border-muted)]" />
			</div>
			{message.summary && (
				<details className="text-xs text-[var(--text-muted)]">
					<summary>查看压缩摘要</summary>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
						{message.summary}
					</pre>
				</details>
			)}
		</div>
	);
});

// ===== 状态栏 =====

function StatusBar({
	status,
	isCompacting,
	workingVisible,
	workingMessage,
}: {
	status: AgentStatus | "idle";
	isCompacting: boolean;
	workingVisible?: boolean;
	workingMessage?: string;
}): React.JSX.Element | null {
	// 压缩进行中：优先显示压缩态（正交于 AgentStatus，压缩时模型不产生 turn 状态）
	if (isCompacting) {
		return (
			<div className="shrink-0 px-4 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
				<div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-layer-02)]">
					<div className="compaction-progress-bar h-full rounded-full bg-amber-400" />
				</div>
				<span className="shrink-0 tabular-nums">正在压缩上下文…</span>
			</div>
		);
	}

	if (status === "idle") return null;
	const working = ["thinking", "responding", "tool-use"].includes(status);
	if (working && workingVisible === false) return null;

	let dotColor = "bg-[var(--text-muted)]";
	let label = "";
	switch (status) {
		case "thinking":
			dotColor = "bg-purple-400";
			label = "思考中…";
			break;
		case "responding":
			dotColor = "bg-blue-400";
			label = "回复中…";
			break;
		case "tool-use":
			dotColor = "bg-amber-400";
			label = "执行工具…";
			break;
		case "awaiting-approval":
			dotColor = "bg-yellow-500";
			label = "等待用户处理…";
			break;
		case "error":
			dotColor = "bg-red-400";
			label = "出错了";
			break;
	}

	return (
		<div className="shrink-0 px-4 py-1 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
			<span
				className={`size-1.5 rounded-full ${dotColor} ${status !== "awaiting-approval" ? "animate-pulse" : ""}`}
			/>
			<span>{working && workingMessage ? workingMessage : label}</span>
		</div>
	);
}
