/** QueueBar —— 输入框上方排队队列（steering/followUp 分组） */

import { ChevronDown, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clearQueue, dispatchQueueItem, removeQueueItem } from "@/lib/api";
import { useChatStore } from "@/stores/chat";

function Row({
	text,
	behavior,
	index,
	revision,
}: {
	text: string;
	behavior: "steer" | "followUp";
	index: number;
	revision?: number;
}) {
	const [busy, setBusy] = useState(false);
	const act = async (fn: () => Promise<unknown>) => {
		const search = location.search;
		setBusy(true);
		try {
			await fn();
		} catch (err) {
			if (location.search === search)
				useChatStore.setState({ lastError: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
		}
	};
	const dispatch = (mode: "steer" | "stop") => {
		if (revision === undefined) return;
		void act(() =>
			dispatchQueueItem({
				requestId: crypto.randomUUID(),
				index,
				behavior,
				expectedText: text,
				revision,
				mode,
			}),
		);
	};
	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs">
			<Badge
				variant={behavior === "steer" ? "default" : "secondary"}
				className="shrink-0 text-[10px]"
			>
				{behavior === "steer" ? "尽快切入" : "任务结束后"}
			</Badge>
			<span className="flex-1 truncate text-muted-foreground" title={text}>
				{text}
			</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						disabled={busy || revision === undefined}
					>
						{busy ? "处理中…" : "立即发送"}
						<ChevronDown className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" side="top" className="max-w-[calc(100vw-2rem)]">
					<DropdownMenuItem className="block" onSelect={() => dispatch("steer")}>
						<div>不停止当前运行，尽快切入</div>
						<div className="mt-1 text-xs text-muted-foreground">
							当前请求不会被打断，在下一次可接收输入时处理。
						</div>
					</DropdownMenuItem>
					<DropdownMenuItem className="block" onSelect={() => dispatch("stop")}>
						<div>停止当前运行后发送</div>
						<div className="mt-1 text-xs text-muted-foreground">
							取消当前审批并停止运行，其他待消息继续保留。
						</div>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Button
				size="sm"
				variant="ghost"
				className="h-5 px-1 text-[10px] text-destructive"
				disabled={busy}
				aria-label="删除这条待消息"
				onClick={() => void act(() => removeQueueItem(index, behavior, text, undefined, revision))}
			>
				<X className="size-3" />
			</Button>
		</div>
	);
}

export function QueueBar() {
	const queue = useChatStore((s) => s.queue);
	const total = queue.steering.length + queue.followUp.length;
	if (total === 0) return null;
	return (
		<div className="space-y-1 px-4 pb-2">
			<div className="flex items-center justify-between text-[10px] text-muted-foreground">
				<span>待消息 {total} 条 · 默认在当前任务结束后发送</span>
				<Button
					size="sm"
					variant="ghost"
					className="h-5 px-1 text-[10px]"
					onClick={() => {
						const search = location.search;
						void clearQueue().catch((err) => {
							if (location.search === search) useChatStore.setState({ lastError: String(err) });
						});
					}}
				>
					<Trash2 className="size-3" /> 清空
				</Button>
			</div>
			{queue.steering.map((t, i) => (
				<Row
					key={`${queue.revision}:s${i}`}
					text={t}
					behavior="steer"
					index={i}
					revision={queue.revision}
				/>
			))}
			{queue.followUp.map((t, i) => (
				<Row
					key={`${queue.revision}:f${i}`}
					text={t}
					behavior="followUp"
					index={i}
					revision={queue.revision}
				/>
			))}
		</div>
	);
}
