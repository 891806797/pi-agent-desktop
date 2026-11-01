/**
 * build —— 单入口打包器：bun install → vite build → bun --compile（前端内嵌，§11）。
 *
 * 用法（根目录 bun run）：
 *   bun run packages/backend/scripts/build.ts                     宿主原生
 *   bun run packages/backend/scripts/build.ts --target=win|linux|mac|mac:x64|bun-<os>-<arch>
 *
 * pi 无平台专属原生依赖，bun 交叉编译可从任意宿主直接编全平台。
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const say = console.log;

const OUT_DIR = "bin";
const FRONTEND_DIR = "packages/frontend";
const DIST_DIR = `${FRONTEND_DIR}/dist`;

const TARGET_ALIASES: Record<string, string> = {
	win: "bun-windows-x64",
	linux: "bun-linux-x64",
	mac: "bun-darwin-arm64",
	"mac:x64": "bun-darwin-x64",
};

function hostTarget(): string | null {
	return process.platform === "win32"
		? "bun-windows-x64"
		: process.platform === "darwin"
			? "bun-darwin-arm64"
			: process.platform === "linux"
				? "bun-linux-x64"
				: null;
}

function removeSourcemaps(dir: string): void {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".map")) unlinkSync(join(dir, name));
	}
}

async function main(): Promise<void> {
	const rawTarget = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
	const target = rawTarget ? (TARGET_ALIASES[rawTarget] ?? rawTarget) : hostTarget();
	if (!target) throw new Error(`不支持的平台 ${process.platform}`);

	say("==> 安装依赖...");
	await $`bun install`;

	say("==> 构建前端（frontend/dist）...");
	await $`cd ${FRONTEND_DIR} && bun run build`;
	if (!existsSync(`${DIST_DIR}/index.html`))
		throw new Error("前端构建产物缺失：frontend/dist/index.html");

	const { version } = await Bun.file("package.json").json();
	const platformArch = target.replace(/^bun-/, "");
	say(`==> 编译可执行文件（target=${target}，内嵌前端）...`);
	// 单引号 JS 字符串：双引号会被 bun 在 win 下的 cmd.exe 安全检查拒
	const compileArgs = [
		"build",
		"--compile",
		"--minify",
		"--sourcemap=none",
		"--asset",
		`./${DIST_DIR}`,
		"--asset",
		"./packages/backend/drizzle",
		"--target",
		target,
		"--outfile",
		`${OUT_DIR}/pi-agent-${platformArch}-v${version}`,
		"--define",
		`APP_VERSION='${version}'`,
		"packages/backend/src/index.ts",
	];
	await $`bun ${compileArgs}`;

	removeSourcemaps(OUT_DIR);
	const exe = existsSync(`${OUT_DIR}/pi-agent-${platformArch}-v${version}.exe`)
		? `pi-agent-${platformArch}-v${version}.exe`
		: `pi-agent-${platformArch}-v${version}`;
	say(`\n打包完成：${OUT_DIR}/${exe}`);
}

await main();
