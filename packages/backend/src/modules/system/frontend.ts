/**
 * 编译版前端静态服务。
 *
 * 打包脚本以 `bun build --compile --asset ./packages/frontend/dist` 把 vite 产物整体嵌入可执行文件，
 * bun 按目录 basename 挂载到 bunfs 根：import.meta.dir/dist（Bun.file 可直读）。
 * 开发模式（bun run dev / bun test）不经编译，前端由 vite dev server 负责，此处 404。
 */

import { existsSync } from "node:fs";
import { posix } from "node:path";

// 编译版 --asset ./packages/frontend/dist 按目录 basename(dist) 挂到 bunfs 根：import.meta.dir/dist。
// dev/test 下 import.meta.dir 为 src/core，无 dist，hasFrontend=false，前端走 vite dev server。
const FRONTEND_DIR = posix.join(import.meta.dir.replace(/\\/g, "/"), "dist");
const hasFrontend = Bun.isStandaloneExecutable && existsSync(FRONTEND_DIR);

const MIME_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	json: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	map: "application/json; charset=utf-8",
};

function extOf(p: string): string {
	const i = p.lastIndexOf(".");
	return i === -1 ? "" : p.slice(i + 1).toLowerCase();
}

/**
 * 前端 catch-all（GET）。必须在所有业务路由之后注册：
 * 命中文件的路径直出；无扩展名的未知路径回退 index.html（SPA 路由）；
 * 带扩展名但未命中直接 404（便于排查）。
 */
export async function serveFrontend(urlPath: string): Promise<Response | null> {
	if (!hasFrontend) return null;
	// 归一化 + 防目录穿越：解析结果必须仍在 FRONTEND_DIR 内
	const resolved = posix.join(FRONTEND_DIR, urlPath);
	if (!resolved.startsWith(`${FRONTEND_DIR}/`)) return new Response("Not Found", { status: 404 });

	let filePath = resolved;
	if (!(await Bun.file(filePath).exists())) {
		if (extOf(urlPath)) return new Response("Not Found", { status: 404 });
		filePath = posix.join(FRONTEND_DIR, "index.html"); // SPA 回退
		if (!(await Bun.file(filePath).exists())) return new Response("Not Found", { status: 404 });
	}
	const type = MIME_TYPES[extOf(filePath)] ?? "application/octet-stream";
	return new Response(Bun.file(filePath), { headers: { "content-type": type } });
}
