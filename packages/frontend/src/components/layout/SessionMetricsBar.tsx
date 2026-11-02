import type { SessionMetrics } from "@pi-agent/common";
import { formatTokens } from "@/lib/format";

export function SessionMetricsBar({
	metrics,
}: {
	metrics: SessionMetrics | null;
}): React.JSX.Element {
	const context = metrics?.contextUsage;
	const percent = context?.percent;
	const contextText = percent != null ? `${percent.toFixed(1)}%` : context ? "待更新" : "—";
	const contextTitle =
		percent != null
			? `当前上下文估算 ${context?.tokens?.toLocaleString()} / ${context?.contextWindow.toLocaleString()} Token，与 pi TUI 相同`
			: context
				? `上下文窗口 ${context.contextWindow.toLocaleString()} Token；压缩后等待下一次有效响应更新估算`
				: "尚无可用的上下文估算";
	const contextColor =
		percent != null && percent > 90
			? "text-[var(--danger-text)]"
			: percent != null && percent > 70
				? "text-[var(--warning-text)]"
				: "text-[var(--text-base)]";
	return (
		<dl
			aria-label="会话统计"
			className="order-last flex w-full shrink-0 items-center justify-between gap-3 border-t border-[var(--border-muted)] py-1 text-xs text-[var(--text-muted)] sm:order-none sm:ml-auto sm:w-auto sm:justify-start sm:gap-4 sm:border-0 sm:py-0"
		>
			<div className="flex items-center gap-1.5" title={contextTitle}>
				<dt>上下文</dt>
				<dd
					className={`flex items-center gap-1.5 tabular-nums ${contextColor}`}
					aria-description={contextTitle}
				>
					<span
						aria-hidden
						className="hidden h-1 w-7 overflow-hidden rounded-full bg-[var(--border-base)] min-[420px]:block"
					>
						<span
							className="block h-full rounded-full bg-current"
							style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
						/>
					</span>
					{contextText}
				</dd>
			</div>
			<div
				className="flex items-center gap-1.5"
				title={`会话累计未缓存输入 ${metrics?.inputTokens.toLocaleString() ?? "0"} Token（与 TUI ↑ 相同，缓存读取/写入另计）`}
			>
				<dt>输入</dt>
				<dd
					className="tabular-nums text-[var(--text-base)]"
					aria-description={`累计未缓存输入 ${metrics?.inputTokens ?? 0} Token`}
				>
					{formatTokens(metrics?.inputTokens ?? 0)}
				</dd>
			</div>
			<div
				className="flex items-center gap-1.5"
				title={`会话累计输出 ${metrics?.outputTokens.toLocaleString() ?? "0"} Token（含压缩摘要等请求，与 TUI ↓ 相同）`}
			>
				<dt>输出</dt>
				<dd
					className="tabular-nums text-[var(--text-base)]"
					aria-description={`累计输出 ${metrics?.outputTokens ?? 0} Token`}
				>
					{formatTokens(metrics?.outputTokens ?? 0)}
				</dd>
			</div>
			<div
				className="flex items-center gap-1.5"
				title="最近一次助手响应：缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入），与 TUI CH 相同；无用量时不计算"
			>
				<dt>缓存命中</dt>
				<dd className="tabular-nums text-[var(--text-base)]">
					{metrics?.cacheHitRate != null ? `${metrics.cacheHitRate.toFixed(1)}%` : "—"}
				</dd>
			</div>
		</dl>
	);
}
