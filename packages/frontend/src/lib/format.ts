/** token 数量简写：<1K 原值；<1M 用 K；>=1M 用 M（保留 1 位小数）。 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

const SHANGHAI_TZ = "Asia/Shanghai";

/** 任意 Date/epoch ms → 北京时间 yyyy-MM-dd HH:mm:ss（不依赖浏览器时区） */
export function beijingFormat(date: Date | number = new Date()): string {
	const d = typeof date === "number" ? new Date(date) : date;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: SHANGHAI_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(d);
	const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** 当前北京时间 yyyy-MM-dd HH:mm:ss */
export function beijingNow(): string {
	return beijingFormat(new Date());
}
