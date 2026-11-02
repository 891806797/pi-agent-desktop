import type { RecoveryActionInput } from "@pi-agent/common";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { recoverRun, urlWorkspace } from "@/lib/api";
import { useChatStore } from "@/stores/chat";

export function RecoveryNotice({ issue }: { issue: import("@pi-agent/common").RunIssue | null }) {
	const sessionId = useChatStore((state) => state.sessionId);
	const connectionError = useChatStore((state) => state.connectionError);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState(false);
	const ids = useRef(new Map<string, string>());
	if (!issue)
		return connectionError ? (
			<div
				role="status"
				className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs"
			>
				<span>连接暂时不可用，聊天记录和后台任务会保留。</span>
				<Button
					size="sm"
					variant="outline"
					onClick={() => window.dispatchEvent(new Event("pi:reconnect"))}
				>
					重试连接
				</Button>
			</div>
		) : null;
	async function act(action: RecoveryActionInput["action"]) {
		const workspace = urlWorkspace();
		if (!issue || !sessionId || !workspace || busy) return;
		const search = location.search;
		const key = `${issue.issueId}:${action}`;
		let actionId = ids.current.get(key);
		if (!actionId) {
			actionId = crypto.randomUUID();
			ids.current.set(key, actionId);
		}
		setBusy(true);
		setError(null);
		try {
			await recoverRun(
				{ actionId, issueId: issue.issueId, expectedRevision: issue.revision, action },
				{ sessionId, workspace },
			);
		} catch (error) {
			if (location.search === search)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			if (location.search === search) {
				setBusy(false);
				setConfirm(false);
			}
		}
	}
	return (
		<section
			role="status"
			aria-label="任务恢复"
			className="shrink-0 border-t border-amber-700/20 bg-amber-700/5 px-4 py-3 text-xs"
		>
			<p className="mb-1 font-medium">
				{issue.kind === "uncertain" ? "需要核对操作结果" : "本轮任务未完成"}
			</p>
			<p className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[var(--text-muted)]">
				{issue.message}
			</p>
			<p className="mt-1 text-[var(--text-muted)]">
				已保存的历史与工具结果会保留，继续时不会重新提交原消息。
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				{issue.allowedActions
					.filter((action) => action !== "abandon")
					.map((action) => (
						<Button key={action} size="sm" disabled={busy} onClick={() => void act(action)}>
							{busy
								? "处理中…"
								: issue.kind === "uncertain"
									? "已核对，继续"
									: action === "retryRecovery"
										? "重试恢复"
										: "继续生成"}
						</Button>
					))}
				{issue.allowedActions.includes("abandon") && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
						放弃本轮
					</Button>
				)}
				<a className="inline-flex items-center underline underline-offset-2" href="/settings">
					检查模型配置
				</a>
			</div>
			{error && (
				<p role="alert" className="mt-2 whitespace-pre-wrap text-destructive">
					{error}
				</p>
			)}
			<Dialog open={confirm} onOpenChange={setConfirm}>
				<DialogContent className="sm:max-w-md">
					<DialogTitle>放弃本轮任务</DialogTitle>
					<DialogDescription>
						将停止本轮并清空待发送队列。已保存的聊天记录和项目文件保留。
					</DialogDescription>
					<Button disabled={busy} onClick={() => void act("abandon")}>
						确认放弃本轮
					</Button>
				</DialogContent>
			</Dialog>
		</section>
	);
}
