import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { AppError } from "@/core/app-error";
import { insidePath } from "./paths";

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

export function expandFileReferences(
	text: string,
	cwd: string,
): { text: string; images: Array<{ type: "image"; data: string; mimeType: string }> } {
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	if (!text.includes("@")) return { text, images };
	const out = text.replace(
		/(^|\s)@(?:"([^"]+)"|([^\s@]+))/g,
		(full, prefix: string, quoted: string | undefined, plain: string | undefined) => {
			const rel = quoted ?? plain!;
			let abs: string;
			try {
				abs = insidePath(cwd, rel);
			} catch {
				return full;
			}
			if (!existsSync(abs)) return full;
			const stat = statSync(abs);
			if (!stat.isFile()) throw new AppError("BAD_REQUEST", "文件引用不能指向目录");
			if (stat.size > 10 * 1024 * 1024)
				throw new AppError("BAD_REQUEST", "引用文件超过 10MB，请缩小文件后重试");
			const ext = extname(abs).toLowerCase();
			if (IMG_EXT.has(ext)) {
				const data = readFileSync(abs).toString("base64");
				images.push({ type: "image", data, mimeType: MIME[ext.slice(1)] ?? "image/png" });
				return `${prefix}<file name="${abs}"></file>`;
			}
			const content = readFileSync(abs, "utf8");
			return `${prefix}<file name="${abs}">\n${content}\n</file>`;
		},
	);
	return { text: out, images };
}
