import { describe, expect, test } from "bun:test";
import { isDangerousCommand, judgeToolCall } from "@/modules/agent/dangerous-commands";

describe("isDangerousCommand", () => {
	test.each([
		["rm -rf /tmp/x"],
		["git push --force origin main"],
		["sudo apt install foo"],
		["Remove-Item -Recurse -Force ."],
		["format C:"],
		["echo hello > /dev/sda1"],
	])("%s 命中黑名单", (cmd) => {
		expect(isDangerousCommand(cmd)).toBe(true);
	});

	test.each([["ls -la"], ["git status"], ["cat README.md"], ["npm run build"]])(
		"%s 安全",
		(cmd) => {
			expect(isDangerousCommand(cmd)).toBe(false);
		},
	);
});

describe("judgeToolCall 分档表", () => {
	const write = { file_path: "a.txt", content: "x" };
	const read = { path: "a.txt" };
	const shellSafe = { command: "ls -la" };
	const shellDanger = { command: "rm -rf /" };

	test("auto 全放行", () => {
		expect(judgeToolCall("auto", "write", write)).toBe("allow");
		expect(judgeToolCall("auto", "bash", shellDanger)).toBe("allow");
	});

	test("standard：读放行、写放行、危险 shell 确认、安全 shell 放行", () => {
		expect(judgeToolCall("standard", "read", read)).toBe("allow");
		expect(judgeToolCall("standard", "write", write)).toBe("allow");
		expect(judgeToolCall("standard", "bash", shellSafe)).toBe("allow");
		expect(judgeToolCall("standard", "bash", shellDanger)).toBe("confirm");
	});

	test("safe：读放行、写确认、shell 一律确认", () => {
		expect(judgeToolCall("safe", "read", read)).toBe("allow");
		expect(judgeToolCall("safe", "write", write)).toBe("confirm");
		expect(judgeToolCall("safe", "bash", shellSafe)).toBe("confirm");
	});

	test("plan：读放行、写/shell 全阻止", () => {
		expect(judgeToolCall("plan", "read", read)).toBe("allow");
		expect(judgeToolCall("plan", "write", write)).toBe("block");
		expect(judgeToolCall("plan", "bash", shellSafe)).toBe("block");
	});
});
