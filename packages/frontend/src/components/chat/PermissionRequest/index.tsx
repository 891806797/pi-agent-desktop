import type {
	AskQuestionPayload,
	PendingRequest,
	ToolPermissionPayload,
	UiConfirmPayload,
	UiEditorPayload,
	UiInputPayload,
	UiSelectPayload,
} from "@pi-agent/common";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OnApprove } from "./ApprovalShell";
import { AskUserQuestionApproval } from "./AskUserQuestionApproval";
import { BashApproval } from "./BashApproval";
import { FallbackApproval } from "./FallbackApproval";
import { WriteApproval } from "./WriteApproval";

function RequestContent({
	request,
	onApprove,
	busy,
	error,
}: {
	request: PendingRequest;
	onApprove: OnApprove;
	busy?: boolean;
	error?: string | null;
}): React.JSX.Element {
	if (request.kind === "ask_question")
		return (
			<AskUserQuestionApproval
				questions={(request.payload as AskQuestionPayload).questions}
				onApprove={onApprove}
			/>
		);
	if (request.kind !== "tool_permission")
		return <UiApproval request={request} onApprove={onApprove} busy={busy} error={error} />;
	const permission = request.payload as ToolPermissionPayload;
	switch (permission.toolName.toLowerCase()) {
		case "bash":
		case "powershell":
			return <BashApproval permission={permission} onApprove={onApprove} />;
		case "write":
		case "edit":
			return <WriteApproval permission={permission} onApprove={onApprove} />;
		default:
			return <FallbackApproval permission={permission} onApprove={onApprove} />;
	}
}

export function PermissionRequest({
	request,
	onApprove,
}: {
	request: PendingRequest;
	onApprove: OnApprove;
}) {
	const pending = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit: OnApprove = async (...args) => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		try {
			await onApprove(...args);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			pending.current = false;
			setBusy(false);
		}
	};
	return (
		<fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-col border-0 p-0">
			{request.expiresAt !== undefined && (
				<p className="mx-4 mt-2 shrink-0 text-xs text-[var(--text-muted)]">
					本次请求截止时间：
					<time dateTime={new Date(request.expiresAt).toISOString()}>
						{new Date(request.expiresAt).toLocaleTimeString()}
					</time>
					。
					{request.kind === "ask_question"
						? "五分钟内未回答，每题按“请自主决策”交给模型继续。"
						: request.kind === "tool_permission"
							? "五分钟未操作，按到期时的模式处理：安全模式拒绝，其他模式允许；计划模式仍限制写入。"
							: "到期后自动取消。"}
				</p>
			)}
			<RequestContent request={request} onApprove={submit} busy={busy} error={error} />
			{error && (
				<p
					role="alert"
					className="mx-4 shrink-0 whitespace-pre-wrap break-words text-xs text-[var(--danger-text)]"
				>
					{error}
				</p>
			)}
		</fieldset>
	);
}
function UiApproval({
	request,
	onApprove,
	busy,
	error,
}: {
	request: PendingRequest;
	onApprove: OnApprove;
	busy?: boolean;
	error?: string | null;
}) {
	const [value, setValue] = useState(
		request.kind === "ui_editor" ? ((request.payload as UiEditorPayload).prefill ?? "") : "",
	);
	const p = request.payload as UiSelectPayload | UiConfirmPayload | UiInputPayload;
	if (request.kind === "ui_editor")
		return (
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open && !busy) void onApprove("cancel");
				}}
			>
				<DialogContent hideClose={busy} className="sm:max-w-2xl">
					<DialogTitle>{p.title}</DialogTitle>
					<DialogDescription>
						编辑内容只保留在当前页面；任一页面提交后，所有页面关闭本次请求。
					</DialogDescription>
					<Textarea
						aria-label={p.title}
						rows={12}
						value={value}
						disabled={busy}
						onChange={(event) => setValue(event.target.value)}
						className="max-h-[50dvh] resize-y whitespace-pre-wrap font-mono text-sm"
					/>
					{error && (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button disabled={busy} variant="outline" onClick={() => void onApprove("cancel")}>
							取消
						</Button>
						<Button disabled={busy} onClick={() => void onApprove("answer", value)}>
							{busy ? "提交中…" : "提交编辑内容"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		);
	return (
		<div className="mx-4 my-2 rounded-lg border border-[var(--border-base)] bg-[var(--bg-layer-01)] p-4 space-y-3">
			<p className="whitespace-pre-wrap break-words">{String(p.title ?? "")}</p>
			{"message" in p && <p className="whitespace-pre-wrap break-words">{p.message}</p>}
			{request.kind === "ui_select" && (
				<select
					aria-label={String(p.title ?? "选择")}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="bg-[var(--bg-layer-02)] rounded p-2"
				>
					<option value="">请选择</option>
					{("options" in p ? p.options : []).map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			)}
			{request.kind === "ui_input" && (
				<Input
					aria-label={String(p.title ?? "输入")}
					placeholder={"placeholder" in p ? p.placeholder : undefined}
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
			)}
			<div className="flex gap-2">
				<Button variant="outline" onClick={() => onApprove("cancel")}>
					取消
				</Button>
				{request.kind === "ui_confirm" && (
					<Button variant="outline" onClick={() => onApprove("answer", false)}>
						否
					</Button>
				)}
				<Button
					disabled={request.kind === "ui_select" && !value}
					onClick={() => onApprove("answer", request.kind === "ui_confirm" ? true : value)}
				>
					{request.kind === "ui_confirm" ? "是" : "提交"}
				</Button>
			</div>
		</div>
	);
}
