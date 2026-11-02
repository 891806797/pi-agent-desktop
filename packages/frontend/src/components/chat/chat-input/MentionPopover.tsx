import { useEffect, useRef } from "react";
import type { FileSearchHit } from "./types";

interface MentionPopoverProps {
	open: boolean;
	results: FileSearchHit[];
	loading: boolean;
	activeIndex: number;
	onSelect: (hit: FileSearchHit) => void;
	onHover: (index: number) => void;
	/** menu 模式（按钮触发）：顶部渲染搜索框，query 来自搜索框 */
	searchMode?: boolean;
	searchQuery?: string;
	onSearchQueryChange?: (q: string) => void;
	onSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

function FileMiniIcon(): React.JSX.Element {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="shrink-0 text-[var(--text-faint)]"
			role="img"
			aria-label="文件"
		>
			<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	);
}

export function MentionPopover({
	open,
	results,
	loading,
	activeIndex,
	onSelect,
	onHover,
	searchMode = false,
	searchQuery,
	onSearchQueryChange,
	onSearchKeyDown,
}: MentionPopoverProps): React.JSX.Element | null {
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const searchRef = useRef<HTMLInputElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 打开时滚动定位初始项
	useEffect(() => {
		itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, open]);

	// menu 模式打开时聚焦搜索框
	useEffect(() => {
		if (open && searchMode) requestAnimationFrame(() => searchRef.current?.focus());
	}, [open, searchMode]);

	if (!open) return null;
	return (
		<div className="absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--bg-base)] shadow-[var(--elevation-raised)] z-40 py-1 flex flex-col">
			{searchMode && (
				<div className="px-2 pb-1 shrink-0">
					<input
						ref={searchRef}
						value={searchQuery}
						onChange={(e) => onSearchQueryChange?.(e.target.value)}
						onKeyDown={onSearchKeyDown}
						placeholder="搜索文件…"
						spellCheck={false}
						className="h-7 w-full rounded-md border border-[var(--border-base)] bg-[var(--bg-layer-01)] px-2 text-[13px] text-[var(--text-base)] outline-none focus:border-[var(--border-strong)]"
					/>
				</div>
			)}
			<div className="overflow-auto">
				{loading && <div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">搜索中…</div>}
				{!loading && results.length === 0 && (
					<div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">无匹配文件</div>
				)}
				{!loading &&
					results.map((hit, i) => (
						<button
							type="button"
							key={hit.path}
							ref={(el) => {
								itemRefs.current[i] = el;
							}}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(hit);
							}}
							onMouseEnter={() => onHover(i)}
							className={[
								"w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
								i === activeIndex ? "bg-[var(--overlay-hover)]" : "",
							].join(" ")}
						>
							<FileMiniIcon />
							<span className="text-[13px] text-[var(--text-base)] truncate shrink-0 max-w-[40%]">
								{hit.name}
							</span>
							<span className="text-[11px] text-[var(--text-faint)] truncate flex-1 text-right">
								{hit.relativePath}
							</span>
						</button>
					))}
			</div>
		</div>
	);
}
