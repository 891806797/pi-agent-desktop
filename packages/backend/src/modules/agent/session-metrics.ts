import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { cacheHitRate, type SessionMetrics } from "@pi-agent/common";

/** TUI 累计遍历全部条目；SDK getSessionStats 已包含压缩、分支摘要及额外 usage。 */
export function readSessionMetrics(
	session: Pick<AgentSession, "getSessionStats" | "sessionManager">,
): SessionMetrics {
	const { tokens, contextUsage } = session.getSessionStats();
	const latest = session.sessionManager
		.getEntries()
		.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	const usage =
		latest?.type === "message" && latest.message.role === "assistant"
			? latest.message.usage
			: undefined;
	return {
		inputTokens: tokens.input,
		outputTokens: tokens.output,
		cacheReadTokens: tokens.cacheRead,
		cacheCreationTokens: tokens.cacheWrite,
		cacheHitRate: usage
			? cacheHitRate({
					inputTokens: usage.input,
					cacheReadTokens: usage.cacheRead,
					cacheCreationTokens: usage.cacheWrite,
				})
			: null,
		contextUsage: contextUsage ?? null,
	};
}
