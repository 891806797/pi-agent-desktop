import { useEffect, useRef } from "react";

export interface ModelItem {
	/** undefined = 默认（继承 SDK 配置） */
	value: string | undefined;
	label: string;
	description?: string;
}

interface ModelSelectorPopoverProps {
	open: boolean;
	loading: boolean;
	items: ModelItem[];
	/** 当前选中的 value；undefined = 默认项高亮 */
	selectedValue: string | undefined;
	query: string;
	activeIndex: number;
	onSelect: (value: string | undefined) => void;
	onQueryChange: (q: string) => void;
	onHover: (index: number) => void;
	/** 文案定制，复用于模型、思考强度和运行模式选择器 */
	searchPlaceholder?: string;
	loadingText?: string;
	emptyText?: string;
}

export function ModelSelectorPopover({
	open,
	loading,
	items,
	selectedValue,
	query,
	activeIndex,
	onSelect,
	onQueryChange,
	onHover,
	searchPlaceholder = "搜索模型…",
	loadingText = "加载模型中…",
	emptyText = "无可用模型",
}: ModelSelectorPopoverProps): React.JSX.Element | null {
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const searchRef = useRef<HTMLInputElement | null>(null);

	// 打开时聚焦搜索框
	useEffect(() => {
		if (open) requestAnimationFrame(() => searchRef.current?.focus());
	}, [open]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 打开时滚动定位初始项
	useEffect(() => {
		itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, open]);

	if (!open) return null;

	return (
		<div className="absolute bottom-full left-2 mb-2 flex w-[min(288px,calc(100vw-2.5rem))] max-h-64 flex-col rounded-xl border border-[var(--border-base)] bg-[var(--bg-base)] py-1 shadow-[var(--elevation-raised)] z-40">
			<div className="px-2 pb-1">
				<input
					ref={searchRef}
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					placeholder={searchPlaceholder}
					spellCheck={false}
					className="h-7 w-full rounded-md border border-[var(--border-base)] bg-[var(--bg-layer-01)] px-2 text-[13px] text-[var(--text-base)] outline-none focus:border-[var(--grey-400)]"
				/>
			</div>
			<div className="overflow-auto">
				{loading && items.length === 0 && (
					<div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">{loadingText}</div>
				)}
				{!loading && items.length === 0 && (
					<div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">{emptyText}</div>
				)}
				{items.map((it, i) => {
					const selected = it.value === selectedValue;
					return (
						<button
							type="button"
							key={it.value ?? "__default__"}
							ref={(el) => {
								itemRefs.current[i] = el;
							}}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(it.value);
							}}
							onMouseEnter={() => onHover(i)}
							className={[
								"flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
								i === activeIndex ? "bg-[var(--overlay-hover)]" : "",
							].join(" ")}
						>
							<span
								className={[
									"truncate text-[13px]",
									it.value === undefined ? "text-[var(--text-muted)]" : "text-[var(--text-base)]",
								].join(" ")}
							>
								{it.label}
							</span>
							{selected && (
								<span className="ml-auto shrink-0 text-[11px] text-[var(--text-faint)]">✓</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
