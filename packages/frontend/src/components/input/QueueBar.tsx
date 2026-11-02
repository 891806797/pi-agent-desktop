/** 待发送消息贴合输入框上沿；操作复用服务端队列的版本校验与幂等发送。 */
import { CornerDownRight, ListEnd, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { dispatchQueueItem, removeQueueItem } from "@/lib/api";
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
	const pending = useRef(false);
	const act = async (action: () => Promise<unknown>) => {
		if (pending.current) return;
		const search = location.search;
		pending.current = true;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			if (location.search === search)
				useChatStore.setState({
					lastError: error instanceof Error ? error.message : String(error),
				});
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	return (
		<li className="flex min-h-12 items-center gap-2 px-3 py-1.5 max-md:px-2" aria-busy={busy}>
			<ListEnd className="size-4 shrink-0 text-[var(--text-faint)]" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate text-sm text-[var(--text-base)]" title={text}>
				{text}
			</span>
			<div className="flex shrink-0 items-center gap-1 text-[var(--text-muted)]">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="h-8 gap-1 rounded-lg px-2 text-xs"
					disabled={busy || revision === undefined}
					title="不停止当前运行，尽快发送这条消息"
					onClick={() => {
						if (revision === undefined) return;
						void act(() =>
							dispatchQueueItem({
								requestId: crypto.randomUUID(),
								index,
								behavior,
								expectedText: text,
								revision,
								mode: "steer",
							}),
						);
					}}
				>
					<CornerDownRight aria-hidden="true" />
					{busy ? "处理中…" : "直接发送"}
				</Button>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="size-8 rounded-lg enabled:hover:text-destructive"
					disabled={busy || revision === undefined}
					aria-label="删除这条待消息"
					title="删除"
					onClick={() =>
						void act(() => removeQueueItem(index, behavior, text, undefined, revision))
					}
				>
					<Trash2 aria-hidden="true" />
				</Button>
			</div>
		</li>
	);
}

export function QueueBar() {
	const queue = useChatStore((state) => state.queue);
	const issue = useChatStore((state) => state.issue);
	// 普通 steer 已交 SDK 处理；失败后保留未消费输入的操作入口。
	const recoverySteering = issue ? queue.steering : [];
	if (queue.followUp.length + recoverySteering.length === 0) return null;
	return (
		<div className="relative mx-3 -mb-4 rounded-t-[22px] border border-b-0 border-[var(--border-muted)] bg-[var(--bg-layer-01)] pb-4 max-md:mx-2">
			<ul
				aria-label="待发送消息"
				className="max-h-40 overflow-y-auto divide-y divide-[var(--border-muted)]"
			>
				{recoverySteering.map((text, index) => (
					<Row
						key={`${queue.revision}:s${index}`}
						text={text}
						behavior="steer"
						index={index}
						revision={queue.revision}
					/>
				))}
				{queue.followUp.map((text, index) => (
					<Row
						key={`${queue.revision}:f${index}`}
						text={text}
						behavior="followUp"
						index={index}
						revision={queue.revision}
					/>
				))}
			</ul>
		</div>
	);
}
