import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { GUTTER, LINE_COLOR, LINE_ERROR, RESULT_PREVIEW_LINES } from "./shared";

/**
 * 原生工具结果的外壳与渐进展开，保留文本格式和可滚动的完整输出。
 */

/** 结果外壳：GUTTER 占位 + 左竖线（error 态变红）+ 内容槽。 */
export const ResultShell = memo(function ResultShell({
	children,
	error,
}: {
	children: ReactNode;
	error?: boolean;
}): React.JSX.Element {
	return (
		<div className="flex flex-row items-start">
			<span className={`${GUTTER} shrink-0`} aria-hidden />
			<div
				className={`flex min-w-0 flex-1 flex-row items-start border-l-2 ${error ? LINE_ERROR : LINE_COLOR}`}
			>
				<span className="w-1.5 shrink-0" />
				<div className="flex-1 min-w-0 py-0.5">{children}</div>
			</div>
		</div>
	);
});

/** 工具输出是原始数据，按文本保留换行；长结果渐进展开，完整内容可滚动。 */
export const Foldable = memo(function Foldable({
	content,
	error,
}: {
	content: string;
	error?: boolean;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const lines = content.split("\n");
	const isShort = lines.length <= RESULT_PREVIEW_LINES && content.length <= 500;
	const textClass = error ? "text-[var(--danger-text)]" : "text-[var(--text-muted)]";
	const output = (text: string) => (
		<pre
			className={`whitespace-pre-wrap break-words font-mono text-xs leading-relaxed ${textClass}`}
		>
			{text}
		</pre>
	);

	if (isShort) {
		return output(content);
	}
	return (
		<>
			<div
				className={`relative ${open ? "max-h-[32rem] overflow-auto rounded" : "max-h-[4.5rem] overflow-hidden"}`}
			>
				{output(open ? content : content.slice(0, 500))}
				{!open && (
					<div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--bg-base)] to-transparent pointer-events-none" />
				)}
			</div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className={`min-h-7 rounded px-1 text-xs hover:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--text-base)] select-none cursor-pointer inline-flex items-center gap-1 mt-0.5 ${textClass}`}
			>
				<ChevronRightIcon
					className={`size-2.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
				/>
				{open ? "收起" : `展开全部 · ${content.length.toLocaleString()} 字符`}
				{error && <span className="text-red-400"> · 错误</span>}
			</button>
		</>
	);
});
