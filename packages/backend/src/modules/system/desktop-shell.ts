import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import { env } from "@/env";

const runFile = promisify(execFile);
// 用户命令没有 fd3，也不能用 exit/exec 终止锚点。stdin 与 SDK 一样为 /dev/null。
const supervisor = `
trap 'kill -KILL -- -$$' EXIT
_pi_marker=$1
shift
(
  trap - EXIT
  "$@" </dev/null 3>&-
  _pi_status=$?
  printf '%s' "$_pi_marker"
  printf '%s' "$_pi_marker" >&2
  printf '%s\\n' "$_pi_status" >&3
) </dev/null &
exec 3>&- 1>/dev/null 2>/dev/null
while IFS= read -r _pi_control; do :; done
`;

interface OwnedGroup {
	child: ChildProcess;
	exited: Promise<void>;
	complete: boolean;
}

/** 每个 Unix shell 的活组长保留 PGID 所有权；空组立即回收，后台工作自然结束后回收。 */
export class DesktopShellHost {
	private groups = new Map<number, OwnedGroup>();
	private stopping = false;
	private shutdown?: Promise<void>;
	private sweeping?: Promise<void>;
	private timer?: ReturnType<typeof setInterval>;

	operations(shellPath?: string): BashOperations {
		return { exec: (command, cwd, options) => this.exec(command, cwd, options, shellPath) };
	}

	private async exec(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
		shellPath?: string,
	) {
		if (this.stopping) throw new Error("Desktop shell host is stopping");
		if (options.signal?.aborted) throw new Error("aborted");
		if (
			options.timeout !== undefined &&
			(!Number.isFinite(options.timeout) ||
				options.timeout <= 0 ||
				options.timeout * 1000 > 2_147_483_647)
		) {
			throw new Error("Invalid timeout");
		}
		const config = getShellConfig(shellPath);
		const controller = getShellConfig();
		const marker = Buffer.from(`\x1e${crypto.randomUUID()}\x1f`);
		const child = spawn(
			controller.shell,
			[
				...controller.args,
				supervisor,
				"pi-desktop-shell",
				marker.toString(),
				config.shell,
				...config.args,
				command,
			],
			{
				cwd,
				env: options.env ?? process.env,
				detached: true,
				stdio: ["pipe", "pipe", "pipe", "pipe"],
			},
		);
		// Windows 不使用此适配；Unix spawn 返回后就持有组长，不依赖扫描捕捉短命父进程。
		const pid = child.pid;
		let resolveExit!: () => void;
		const owned: OwnedGroup = {
			child,
			complete: false,
			exited: new Promise((resolve) => {
				resolveExit = resolve;
			}),
		};
		if (pid) this.groups.set(pid, owned);
		child.stdin?.on("error", () => {});
		const reaped = () => {
			if (pid) this.groups.delete(pid);
			for (const stream of child.stdio) stream?.destroy();
			resolveExit();
		};
		child.once("exit", reaped);
		child.once("error", reaped);
		this.timer ??= setInterval(() => void this.sweep(), 1000);
		this.timer.unref();
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		try {
			return await new Promise<{ exitCode: number }>((resolve, reject) => {
				let frame = "";
				let settled = false;
				let completedStreams = 0;
				let exitCode: number | undefined;
				const finish = () => {
					if (!settled && completedStreams === 2 && exitCode !== undefined) {
						settled = true;
						owned.complete = true;
						resolve({ exitCode });
					}
				};
				const fail = (error: Error) => {
					if (settled) return;
					settled = true;
					this.kill(owned);
					reject(error);
				};
				abort = () => fail(new Error("aborted"));
				for (const stream of [child.stdout, child.stderr]) {
					let pending = Buffer.alloc(0);
					let ended = false;
					stream?.on("data", (chunk: Buffer) => {
						// 完成标记与输出在同一 pipe 排序；最多保留一个标记长度，后台输出持续丢弃/drain。
						if (ended || settled) return;
						pending = Buffer.concat([pending, chunk]);
						const at = pending.indexOf(marker);
						if (at >= 0) {
							if (at) options.onData(pending.subarray(0, at));
							pending = Buffer.alloc(0);
							ended = true;
							completedStreams++;
							finish();
						} else {
							let keep = Math.min(pending.length, marker.length - 1);
							while (keep && !pending.subarray(-keep).equals(marker.subarray(0, keep))) keep--;
							const count = pending.length - keep;
							if (count) options.onData(pending.subarray(0, count));
							pending = pending.subarray(count);
						}
					});
					stream?.on("error", () => fail(new Error("Shell output pipe failed")));
				}
				child.once("error", fail);
				child.once("exit", () => {
					if (!settled) fail(new Error("Shell exited without completion frame"));
				});
				const control = child.stdio[3] as Readable;
				control.on("data", (chunk: Buffer) => {
					frame += chunk.toString();
					if (frame.length > 16 || (frame.includes("\n") && !/^\d{1,3}\n$/.test(frame))) {
						fail(new Error("Invalid shell completion frame"));
					} else if (frame.endsWith("\n") && !settled) {
						exitCode = Number(frame.trim());
						finish();
					}
				});
				control.on("error", () => fail(new Error("Shell completion pipe failed")));
				control.on("end", () => {
					if (exitCode === undefined && !settled) fail(new Error("Shell completion pipe closed"));
				});
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) abort();
				if (options.timeout !== undefined)
					deadline = setTimeout(
						() => fail(new Error(`timeout:${options.timeout}`)),
						options.timeout * 1000,
					);
			});
		} finally {
			if (deadline) clearTimeout(deadline);
			options.signal?.removeEventListener("abort", abort);
			await this.sweep();
		}
	}

	private kill(group: OwnedGroup) {
		const { child } = group;
		if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}

	private sweep(): Promise<void> {
		this.sweeping ??= (async () => {
			if (!this.groups.size || this.stopping) return;
			// 只检查快照开始前已完成的命令，不能用旧快照回收刚创建/刚完成的组。
			const candidates = [...this.groups].filter(([, group]) => group.complete);
			if (!candidates.length) return;
			try {
				// 扫描只负责回收已拥有的空组，不用于发现/认领进程或按环境变量杀进程。
				const { stdout } = await runFile("ps", ["-axo", "pid=,pgid=,stat="], {
					timeout: 1000,
					maxBuffer: 8 * 1024 * 1024,
				});
				const busy = new Set<number>();
				for (const line of stdout.trim().split("\n")) {
					const [pid, pgid, state] = line.trim().split(/\s+/);
					if (pid !== pgid && !state?.startsWith("Z")) busy.add(Number(pgid));
				}
				await Promise.all(
					candidates.map(async ([pid, group]) => {
						if (group.complete && !busy.has(pid)) {
							this.kill(group);
							await group.exited;
						}
					}),
				);
			} catch {
				/* ps 暂不可用时保留所有权，退出仍会清理，不冒险释放活组。 */
			}
		})().finally(() => {
			this.sweeping = undefined;
		});
		return this.sweeping;
	}

	stop(): Promise<void> {
		this.shutdown ??= (async () => {
			this.stopping = true;
			if (this.timer) clearInterval(this.timer);
			const groups = [...this.groups.values()];
			for (const group of groups) this.kill(group);
			await Promise.all(groups.map((group) => group.exited));
		})();
		return this.shutdown;
	}
}

export const desktopShellHost =
	env.desktopToken !== undefined && process.platform !== "win32"
		? new DesktopShellHost()
		: undefined;
