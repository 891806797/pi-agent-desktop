/**
 * Markdown 渲染组件：react-markdown + remark-gfm 将 AI 回复转 React 组件树。
 *
 * 视觉风格：代码块深色圆角不显语言标签；行内代码深绿色；引用块 ▎ 前缀斜体；
 * H1 bold+italic+underline，H2+ bold；删除线弱化；Thinking 淡色渲染。
 *
 * 流式性能：memo 避免历史消息重复 parse；useDeferredValue 将 parse 让到低优先级 lane。
 */

import { memo, useDeferredValue } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
	children: string;
	/** Thinking 块等淡色场景 */
	dimColor?: boolean;
	/** 流式输出中：可延迟渲染（滞后一两帧无感），仍走 Markdown */
	isStreaming?: boolean;
}

// ── 颜色 ──

const textColor = (dim?: boolean) => (dim ? "text-[var(--text-faint)]" : "text-[var(--text-base)]");

/** 行内代码颜色 — 深绿色 */
const INLINE_CODE_COLOR = "text-[#1a7f37]";

// ── 组件映射 ──

const components: Components = {
	// ── 标题：H1 = bold+italic+underline, H2+ = bold ──
	h1: ({ children }) => (
		<h1 className={`text-[18px] font-bold italic underline mt-4 mb-2 ${textColor()}`}>
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className={`text-[16px] font-bold mt-3 mb-1.5 ${textColor()}`}>{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className={`text-[15px] font-bold mt-2 mb-1 ${textColor()}`}>{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className={`text-[15px] font-bold mt-2 mb-1 ${textColor()}`}>{children}</h4>
	),
	h5: ({ children }) => (
		<h5 className={`text-[14px] font-bold mt-1.5 mb-0.5 ${textColor()}`}>{children}</h5>
	),
	h6: ({ children }) => (
		<h6 className={`text-[14px] font-bold mt-1.5 mb-0.5 ${textColor()}`}>{children}</h6>
	),

	p: ({ children }) => (
		<p className={`text-[15px] leading-relaxed my-1 ${textColor()}`}>{children}</p>
	),

	// ── 列表 ──
	ul: ({ children }) => (
		<ul className={`list-disc pl-5 my-1.5 space-y-0.5 ${textColor()}`}>{children}</ul>
	),
	ol: ({ children }) => (
		<ol className={`list-decimal pl-5 my-1.5 space-y-0.5 ${textColor()}`}>{children}</ol>
	),
	li: ({ children }) => (
		<li className={`text-[15px] leading-relaxed pl-1 ${textColor()}`}>{children}</li>
	),

	// ── 引用块：▎ 前缀 + 斜体 ──
	blockquote: ({ children }) => (
		<blockquote className="my-2 italic text-[var(--text-muted)]">
			<span className="not-italic text-[var(--text-faint)] select-none mr-1">▎</span>
			{children}
		</blockquote>
	),

	hr: () => <hr className="my-3 border-[var(--border-muted)]" />,

	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,

	// 删除线 — remark-gfm 默认启用，但模型常用 ~ 表示"大约"，弱化样式避免误读
	del: ({ children }) => <del className="line-through opacity-60">{children}</del>,

	// ── 链接 — 深绿色 ──
	a: ({ href, children }) => (
		<a
			href={href}
			className="text-[#1a7f37] hover:text-[#2ea043] underline underline-offset-2"
			target="_blank"
			rel="noopener noreferrer"
		>
			{children}
		</a>
	),

	// ── 围栏代码块 — 不显示语言标签（仅供语法高亮用）──
	pre: ({ children }) => (
		<pre className="my-2 text-[13px] leading-relaxed whitespace-pre-wrap font-mono bg-[var(--bg-layer-01)] p-3 rounded-lg border border-[var(--border-muted)] overflow-x-auto">
			{children}
		</pre>
	),

	// code：行内 vs 围栏块内
	code: ({ className, children, ...props }) => {
		const isBlock = className?.startsWith("language-");
		if (isBlock) {
			// 围栏代码块内的 code — 不显示语言标签，仅语法高亮用
			return (
				<code className={className} {...props}>
					{children}
				</code>
			);
		}
		// 行内 code — 深绿色
		return (
			<code
				className={`text-[13px] font-mono bg-[var(--bg-layer-01)] px-1.5 py-0.5 rounded ${INLINE_CODE_COLOR}`}
			>
				{children}
			</code>
		);
	},

	// ── 表格 ──
	table: ({ children }) => (
		<div className="my-2 overflow-x-auto">
			<table className="min-w-full text-[13px] border border-[var(--border-muted)] rounded">
				{children}
			</table>
		</div>
	),
	thead: ({ children }) => <thead className="bg-[var(--bg-layer-01)]">{children}</thead>,
	tbody: ({ children }) => <tbody>{children}</tbody>,
	tr: ({ children }) => <tr className="border-b border-[var(--border-muted)]">{children}</tr>,
	th: ({ children }) => (
		<th className={`px-3 py-1.5 text-left font-semibold ${textColor()}`}>{children}</th>
	),
	td: ({ children }) => <td className={`px-3 py-1.5 ${textColor()}`}>{children}</td>,

	img: ({ src, alt }) => <img src={src} alt={alt ?? ""} className="max-w-full rounded my-2" />,
};

/** dim 色组件变体（Thinking 块内用） */
const dimComponents: Components = {
	...components,
	h1: ({ children }) => (
		<h1 className={`text-[14px] font-bold italic underline mt-2 mb-1 ${textColor(true)}`}>
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className={`text-[13px] font-bold mt-1.5 mb-0.5 ${textColor(true)}`}>{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className={`text-[12px] font-bold mt-1 mb-0.5 ${textColor(true)}`}>{children}</h3>
	),
	p: ({ children }) => (
		<p className={`text-[12px] leading-relaxed my-0.5 ${textColor(true)}`}>{children}</p>
	),
	li: ({ children }) => (
		<li className={`text-[12px] leading-relaxed pl-1 ${textColor(true)}`}>{children}</li>
	),
	pre: ({ children }) => (
		<pre className="my-1 text-[11px] leading-relaxed whitespace-pre-wrap font-mono bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)] overflow-x-auto">
			{children}
		</pre>
	),
	code: ({ className, children, ...props }) => {
		const isBlock = className?.startsWith("language-");
		if (isBlock)
			return (
				<code className={className} {...props}>
					{children}
				</code>
			);
		return (
			<code className="text-[11px] font-mono bg-[var(--bg-layer-01)] px-1 py-0.5 rounded text-[var(--text-faint)]">
				{children}
			</code>
		);
	},
	// dim 引用块
	blockquote: ({ children }) => (
		<blockquote className="my-1 italic text-[var(--text-faint)]">
			<span className="not-italic text-[var(--text-faint)] select-none mr-1">▎</span>
			{children}
		</blockquote>
	),
};

// memo：children 与 dimColor 均为值类型，浅比较即可；流式时仅末尾消息文本变化，历史消息不重复 parse
export const Markdown = memo(function Markdown({
	children,
	dimColor,
	isStreaming,
}: MarkdownProps): React.JSX.Element {
	// 流式中延迟一帧渲染：ReactMarkdown parse 让位给输入/滚动等紧急更新，肉眼无感
	const deferred = useDeferredValue(children);
	const text = isStreaming ? deferred : children;
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={dimColor ? dimComponents : components}>
			{text}
		</ReactMarkdown>
	);
});
