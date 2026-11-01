import type { SlashCommand } from "@pi-agent/common";
import { useEffect, useRef } from "react";

interface CommandPopoverProps {
	open: boolean;
	/** 已过滤排序的命令列表（由父组件计算） */
	commands: SlashCommand[];
	activeIndex: number;
	onSelect: (cmd: SlashCommand) => void;
	onHover: (index: number) => void;
}

export function CommandPopover({
	open,
	commands,
	activeIndex,
	onSelect,
	onHover,
}: CommandPopoverProps): React.JSX.Element | null {
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 打开时滚动定位初始项
	useEffect(() => {
		itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, open]);

	if (!open) return null;
	return (
		<div className="absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--bg-base)] shadow-[var(--elevation-raised)] z-40 py-1 flex flex-col">
			<div className="overflow-auto">
				{commands.length === 0 && (
					<div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">无匹配命令</div>
				)}
				{commands.map((cmd, i) => (
					<button
						type="button"
						key={`${cmd.name}-${i}`}
						ref={(el) => {
							itemRefs.current[i] = el;
						}}
						onMouseDown={(e) => {
							e.preventDefault();
							onSelect(cmd);
						}}
						onMouseEnter={() => onHover(i)}
						className={[
							"w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
							i === activeIndex ? "bg-[var(--overlay-hover)]" : "",
						].join(" ")}
					>
						<code className="text-[13px] font-mono text-[var(--text-base)] shrink-0">
							/{cmd.name}
						</code>

						<span className="text-[12px] text-[var(--text-faint)] truncate flex-1 text-right">
							{cmd.description}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
