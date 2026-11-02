/** Shared Bun compiler; desktop owns its UI and does not embed frontend assets. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const aliases: Record<string, string> = {
	win: "bun-windows-x64",
	linux: "bun-linux-x64",
	mac: "bun-darwin-arm64",
	"mac:x64": "bun-darwin-x64",
};
export function hostTarget(
	platform: string = process.platform,
	arch: string = process.arch,
): string | null {
	const os = ({ win32: "windows", darwin: "darwin", linux: "linux" } as Record<string, string>)[
		platform
	];
	return os && ["x64", "arm64"].includes(arch) ? `bun-${os}-${arch}` : null;
}
export async function run(command: string[], cwd = repoRoot): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	if ((await child.exited) !== 0) throw new Error(`Command failed: ${command[0]} ${command[1]}`);
}
export async function compileBackend(
	target: string,
	outfile: string,
	desktop = false,
): Promise<void> {
	const { version } = await Bun.file(resolve(repoRoot, "package.json")).json();
	mkdirSync(dirname(outfile), { recursive: true });
	await run([
		process.execPath,
		"build",
		"--compile",
		"--minify",
		"--sourcemap=none",
		...(desktop ? ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"] : []),
		...(!desktop ? ["--asset", "./packages/frontend/dist"] : []),
		"--asset",
		"./packages/backend/drizzle",
		"--target",
		target,
		"--outfile",
		outfile,
		"--define",
		`APP_VERSION=${JSON.stringify(version)}`,
		"packages/backend/src/index.ts",
	]);
}
if (import.meta.main) {
	const raw = process.argv.find((arg) => arg.startsWith("--target="))?.slice(9);
	const target = raw ? (aliases[raw] ?? raw) : hostTarget();
	if (!target) throw new Error(`Unsupported host ${process.platform}/${process.arch}`);
	await run([process.execPath, "run", "build"], resolve(repoRoot, "packages/frontend"));
	if (!existsSync(resolve(repoRoot, "packages/frontend/dist/index.html")))
		throw new Error("Missing frontend dist");
	const { version } = await Bun.file(resolve(repoRoot, "package.json")).json();
	await compileBackend(
		target,
		resolve(
			repoRoot,
			`bin/pi-agent-${target.replace(/^bun-/, "")}-v${version}${target.includes("windows") ? ".exe" : ""}`,
		),
	);
}
