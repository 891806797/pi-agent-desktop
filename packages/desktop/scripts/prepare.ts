import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compileBackend, repoRoot, run } from "../../backend/scripts/build";

export const desktopDir = join(repoRoot, "packages/desktop");
export const nativeDir = join(desktopDir, "src-tauri");
export const targets = {
	"x86_64-pc-windows-msvc": "bun-windows-x64",
	"aarch64-apple-darwin": "bun-darwin-arm64",
	"x86_64-apple-darwin": "bun-darwin-x64",
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
} as const;
export function desktopTarget(target: string) {
	if (!(target in targets)) throw new Error(`Unsupported desktop target: ${target}`);
	return {
		bun: targets[target as keyof typeof targets],
		filename: `pi-agent-sidecar-${target}${target.includes("windows") ? ".exe" : ""}`,
	};
}
export function nativeTarget(): string {
	const target = (
		{
			"win32-x64": "x86_64-pc-windows-msvc",
			"darwin-arm64": "aarch64-apple-darwin",
			"darwin-x64": "x86_64-apple-darwin",
			"linux-x64": "x86_64-unknown-linux-gnu",
		} as Record<string, string>
	)[`${process.platform}-${process.arch}`];
	if (!target) throw new Error(`Unsupported desktop host ${process.platform}/${process.arch}`);
	return target;
}
export function assertReleaseVersions(root: string, desktop: string, native: string, tag?: string) {
	if (root !== desktop || root !== native || (tag && tag !== `v${root}`))
		throw new Error(
			`Release version mismatch: root=${root}, desktop=${desktop}, native=${native}, tag=${tag}`,
		);
}
export async function verifyVersions(tag?: string) {
	const root = await Bun.file(join(repoRoot, "package.json")).json();
	const desktop = await Bun.file(join(desktopDir, "package.json")).json();
	const native = await Bun.file(join(nativeDir, "tauri.conf.json")).json();
	const cargo = readFileSync(join(nativeDir, "Cargo.toml"), "utf8");
	const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
	assertReleaseVersions(root.version, desktop.version, native.version, tag);
	if (cargoVersion !== root.version) throw new Error(`Cargo version mismatch: ${cargoVersion}`);
}
export function assertResources(dir = nativeDir) {
	const file = join(dir, "resources/photon_rs_bg.wasm");
	if (
		!existsSync(file) ||
		!readFileSync(file)
			.subarray(0, 8)
			.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
	)
		throw new Error(`Missing or invalid Photon WASM: ${file}`);
}
export function sdkUtils() {
	return join(
		dirname(
			Bun.resolveSync("@earendil-works/pi-coding-agent", join(repoRoot, "packages/backend/src")),
		),
		"utils",
	);
}
export async function prepare(args = process.argv.slice(2)) {
	const pos = args.indexOf("--target");
	const target =
		args.find((arg) => arg.startsWith("--target="))?.slice(9) ??
		(pos >= 0 ? args[pos + 1] : undefined) ??
		process.env.TAURI_ENV_TARGET_TRIPLE ??
		nativeTarget();
	const resolved = desktopTarget(target);
	await verifyVersions();
	const require = createRequire(join(sdkUtils(), "photon.js"));
	const wasm = join(dirname(require.resolve("@silvia-odwyer/photon-node")), "photon_rs_bg.wasm");
	mkdirSync(join(nativeDir, "resources"), { recursive: true });
	copyFileSync(wasm, join(nativeDir, "resources/photon_rs_bg.wasm"));
	assertResources();
	if (args.includes("--frontend"))
		await run([process.execPath, "run", "build"], join(repoRoot, "packages/frontend"));
	await compileBackend(resolved.bun, join(nativeDir, "binaries", resolved.filename), true);
	console.log(`Prepared desktop sidecar: ${resolved.filename}`);
}
if (import.meta.main) await prepare();
