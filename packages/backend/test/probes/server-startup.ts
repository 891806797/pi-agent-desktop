/** 只信任测试子进程成功绑定后的输出，不把其他进程的 health 响应当作测试服务。 */
export async function waitForServer(stdout: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				let buffer = "";
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) throw new Error("测试子进程退出，未成功绑定 HTTP 端口");
					buffer += decoder.decode(value, { stream: true });
					const match = /\[pi-agent\] listening on (http:\/\/[^\s]+)\r?\n/.exec(buffer);
					if (match?.[1]) return match[1].replace(/\/$/, "");
				}
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("测试子进程启动超时")), 8000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		reader.releaseLock();
	}
}
