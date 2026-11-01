/**
 * 危险命令黑名单 —— run mode 分档的判定依据（standard 档仅命中此表才弹确认）。
 * bash / powershell 双语法；正则对整条命令做大小写不敏感匹配。
 */

import type { RunMode } from "@pi-agent/common";

const DANGEROUS_PATTERNS: RegExp[] = [
	// 递归/强制删除
	/\brm\s+(-[a-z]*[rf][a-z]*\s+|.*--no-preserve-root)/i,
	/\bdel\s+\/[sqr]/i,
	/\brmdir\s+\/s/i,
	/\bremove-item\b[^|]*-recurse/i,
	/\brmdir\s+\/[sq]/i,
	/\bunlink\b.*\*/i,
	// 磁盘/系统级
	/\bformat\b/i,
	/\bmkfs\b/i,
	/\bdiskpart\b/i,
	/\bcd\b.*\bformat\b/i,
	// 提权
	/\bsudo\b/i,
	/\brunas\b/i,
	/\bstart-process\b[^|]*-verb\s+runas/i,
	// 强推/重置仓库
	/\bgit\s+push\b[^|]*--force/i,
	/\bgit\s+push\s+-f\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	// 服务/进程
	/\bkill\s+-9\b/i,
	/\btaskkill\b[^|]*\/f/i,
	/\bstop-computer\b/i,
	/\brestart-computer\b/i,
	/\bshutdown\b/i,
	// 包管理器执行任意脚本
	/\bnpx\b[^|]*\|\s*sh\b/i,
	/\bcurl\b[^|]*\|\s*(ba)?sh\b/i,
	/\biwr\b[^|]*\|\s*iex\b/i,
	/\binvoke-expression\b/i,
	// 重定向覆盖系统路径
	/>\s*\/dev\/sd[a-z]/i,
	/>\s*[a-z]:\\windows/i,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

/**
 * run mode 分档判定（实施计划 §5.4）。返回三态：
 * - allow：直接放行
 * - block：直接阻止（pi 拿到 { block: true, reason }）
 * - confirm：弹审批卡片等待用户
 */
export type GateJudgment = "allow" | "block" | "confirm";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function judgeToolCall(
	mode: RunMode,
	toolName: string,
	input: Record<string, unknown>,
): GateJudgment {
	if (mode === "auto") return "allow";
	// 提问本身不读写工作区；答案仍由 ask 工具等待用户提交。
	if (toolName === "ask_user_question") return "allow";
	if (READ_TOOLS.has(toolName)) return "allow";

	if (mode === "plan") {
		// 计划模式：一切变更类操作直接阻止，reason 引导先与用户确认方案
		return "block";
	}

	if (WRITE_TOOLS.has(toolName)) {
		return mode === "safe" ? "confirm" : "allow";
	}

	if (SHELL_TOOLS.has(toolName)) {
		const command = String(input.command ?? "");
		const dangerous = command !== "" && isDangerousCommand(command);
		if (mode === "standard") return dangerous ? "confirm" : "allow";
		// safe：shell 一律确认
		return "confirm";
	}

	// 未知/自定义工具：standard 放行，safe 确认
	return mode === "safe" ? "confirm" : "allow";
}

export const BLOCK_REASON_PLAN =
	"当前处于计划（plan）模式，禁止执行变更类操作。请先与用户确认方案后切换运行模式。";
