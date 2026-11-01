import { expect, test } from "bun:test";

test("项目坐标跟随 URL，重复点击当前项目不清会话，旧会话列表不能覆盖新项目", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/navigation.tsx"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});

test("思考中 A→B→C 丢弃旧快照/事件，项目切换清理消息、审批、队列及 SSE，后台任务不被中止", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/switch-hook.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
