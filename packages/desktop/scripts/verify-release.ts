/** Exercise the bundled executable from a writable, isolated Unicode path. */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { repoRoot, run } from "../../backend/scripts/build";
import { desktopTarget, nativeDir, nativeTarget, sdkUtils, verifyVersions } from "./prepare";

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
	);
}
async function smoke(executable: string, wasm: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-桌面冒烟-"));
	try {
		const exe = join(dir, basename(executable));
		cpSync(executable, exe);
		cpSync(wasm, join(dir, "photon_rs_bg.wasm"));
		const token = crypto.randomUUID();
		// Keep stdin piped: EOF is intentionally a desktop shutdown signal.
		const child = Bun.spawn([exe], {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				USERPROFILE: dir,
				SYSTEMROOT: process.env.SYSTEMROOT,
				PI_DESKTOP_TOKEN: token,
				DATA_DIR: join(dir, "data"),
				PORT: "0",
				NODE_ENV: "production",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Sidecar smoke timeout")), 30000);
		});
		try {
			const check = async () => {
				let pending = "";
				let ready: { protocol: number; url: string; version: string } | undefined;
				for await (const chunk of child.stdout) {
					pending += new TextDecoder().decode(chunk);
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						try {
							const value = JSON.parse(line);
							if (value.type === "ready") ready = value;
						} catch {}
						newline = pending.indexOf("\n");
					}
					if (ready) break;
				}
				const { version } = await Bun.file(join(repoRoot, "package.json")).json();
				if (
					ready?.protocol !== 1 ||
					ready.version !== version ||
					new URL(ready.url).hostname !== "127.0.0.1"
				)
					throw new Error("Invalid ready frame");
				for (const headers of [new Headers(), new Headers({ "x-pi-desktop-token": "wrong" })]) {
					const denied = await fetch(new URL("/api/health", ready.url), { headers });
					if (denied.status !== 401 && denied.status !== 403)
						throw new Error(`Unauthenticated API allowed: ${denied.status}`);
				}
				const health = await fetch(new URL("/api/health", ready.url), {
					headers: { "x-pi-desktop-token": token },
				});
				if (!health.ok) throw new Error(`Health failed: ${health.status}`);
				child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
				child.stdin.end();
				if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
			};
			await Promise.race([check(), deadline]);
		} finally {
			clearTimeout(timer);
			child.kill();
			await child.exited;
		}
		// Upstream's supported in-process fallback must still perform real WASM resize.
		const probe = join(dir, "image-probe.ts");
		writeFileSync(
			probe,
			`import fs from 'node:fs';\nimport { resizeImage } from ${JSON.stringify(join(sdkUtils(), "image-resize.js"))};\nconst read = fs.readFileSync; fs.readFileSync = function(file,...args) { if(String(file).endsWith('photon_rs_bg.wasm') && !String(file).startsWith(process.cwd())) { const e = new Error('isolated source path'); e.code='ENOENT'; throw e; } return read.call(this,file,...args); };\nconst png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=','base64');\nconst result=await resizeImage(png,'image/png',{maxWidth:1,maxHeight:1});\nif(!result || result.width!==1 || result.height!==1 || !result.wasResized) throw new Error('Photon WASM image resize failed');\nconsole.log('WASM resize passed');`,
		);
		const imageExe = join(dir, `image-probe${process.platform === "win32" ? ".exe" : ""}`);
		await run([
			process.execPath,
			"build",
			"--compile",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			probe,
			"--outfile",
			imageExe,
		]);
		rmSync(probe);
		await run([imageExe], dir);
		console.log("Packaged sidecar authentication / ready / shutdown / Photon image smoke passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
if (import.meta.main) {
	await verifyVersions(process.env.RELEASE_TAG);
	const args = process.argv.slice(2);
	const bundle = args.includes("--bundle");
	let source = nativeDir;
	let extracted: string | undefined;
	try {
		if (bundle) {
			const root = resolve(
				args[args.indexOf("--bundle") + 1] ??
					join(nativeDir, "target", nativeTarget(), "release/bundle"),
			);
			if (process.platform === "darwin") source = root;
			else {
				const sevenZip = process.platform === "win32" ? Bun.which("7z") : null;
				const installer = files(root).find((p) =>
					process.platform === "win32"
						? p.endsWith(sevenZip ? ".exe" : ".msi")
						: p.endsWith(".deb"),
				);
				if (!installer) throw new Error(`Missing installer in ${root}`);
				extracted = mkdtempSync(join(tmpdir(), "pi-installer-"));
				source = extracted;
				if (process.platform === "win32" && sevenZip)
					await run([sevenZip, "x", installer, `-o${extracted}`, "-y"]);
				else if (process.platform === "win32")
					// Administrative extraction creates a source layout without installing the app.
					await run([
						"msiexec.exe",
						"/a",
						installer,
						"/qn",
						`TARGETDIR=${extracted}`,
						"/L*v",
						join(extracted, "extract.log"),
					]);
				else await run(["dpkg-deb", "-x", installer, extracted]);
			}
		}
		const all = files(source);
		const executable = all.find((p) =>
			bundle
				? /^pi-agent-sidecar(?:\.exe)?$/.test(basename(p))
				: basename(p) === desktopTarget(nativeTarget()).filename,
		);
		const wasm = all.find((p) => basename(p) === "photon_rs_bg.wasm");
		if (!executable || !wasm)
			throw new Error(`Installer is missing sidecar or Photon WASM: ${source}`);
		if (readFileSync(wasm).byteLength < 8) throw new Error("Invalid bundled WASM");
		await smoke(executable, wasm);
	} finally {
		if (extracted) rmSync(extracted, { recursive: true, force: true });
	}
}
