/** 工作区文件管理；授权与物理路径约束复用 system 边界，不依赖会话运行时。 */
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { FilePath, UploadFilesInput } from "@pi-agent/common/dto/requests";
import { AppError } from "@/core/app-error";
import { containsPath, insidePath } from "./paths";
import { resolveWorkspaceB64 } from "./workspace-registry";

const MAX_BYTES = 1_048_576;
const revisionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function filePath(root: string, path: string) {
	if (!FilePath.safeParse(path).success) throw new AppError("BAD_REQUEST", "文件路径不合法");
	const full = insidePath(root, path);
	// 链接本身不作为管理对象，避免保存时替换链接或删除目录联动出错。
	if (existsSync(full) && lstatSync(full).isSymbolicLink())
		throw new AppError("BAD_REQUEST", "不支持操作符号链接");
	return full;
}
function attempt<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		if (error instanceof AppError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new AppError("NOT_FOUND", "文件或目录不存在，请刷新后重试");
		if (code === "EEXIST" || code === "ENOTEMPTY")
			throw new AppError("FILE_CONFLICT", "目标已存在，请更换名称");
		if (code === "EACCES" || code === "EPERM")
			throw new AppError("FORBIDDEN", "无法访问文件，请检查权限或文件占用");
		throw new AppError("BAD_REQUEST", "文件操作失败，请检查路径及文件占用");
	}
}
function textBytes(full: string) {
	const stat = statSync(full);
	if (!stat.isFile()) throw new AppError("BAD_REQUEST", "只能编辑普通文件");
	if (stat.size > MAX_BYTES) throw new AppError("BAD_REQUEST", "仅支持编辑 1MB 内的文本文件");
	const bytes = readFileSync(full);
	if (bytes.length > MAX_BYTES || bytes.includes(0))
		throw new AppError("BAD_REQUEST", "文件过大或不是 UTF-8 文本");
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new AppError("BAD_REQUEST", "仅支持编辑 UTF-8 文本文件");
	}
	return bytes;
}
export function readContent(userId: string, dir: string, path: string) {
	return attempt(() => {
		const bytes = textBytes(filePath(resolveWorkspaceB64(userId, dir), path));
		return { content: bytes.toString("utf8"), revision: revisionOf(bytes) };
	});
}
export function saveContent(
	userId: string,
	dir: string,
	path: string,
	content: string,
	revision: string,
) {
	return attempt(() => {
		const full = filePath(resolveWorkspaceB64(userId, dir), path);
		const current = textBytes(full);
		if (revisionOf(current) !== revision)
			throw new AppError("FILE_CONFLICT", "文件已被其他操作修改，请保留当前内容并重新打开文件");
		const bytes = Buffer.from(content, "utf8");
		if (bytes.length > MAX_BYTES || bytes.includes(0))
			throw new AppError("BAD_REQUEST", "仅支持保存 1MB 内的文本文件");
		const temporary = `${full}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, bytes, { flag: "wx", mode: statSync(full).mode });
			renameSync(temporary, full);
		} finally {
			rmSync(temporary, { force: true });
		}
		return { revision: revisionOf(bytes) };
	});
}
export function createEntry(userId: string, dir: string, path: string, kind: "file" | "dir") {
	return attempt(() => {
		const full = filePath(resolveWorkspaceB64(userId, dir), path);
		mkdirSync(dirname(full), { recursive: true });
		if (kind === "dir") mkdirSync(full);
		else writeFileSync(full, "", { flag: "wx" });
		return { path };
	});
}
export function deleteEntry(userId: string, dir: string, path: string) {
	return attempt(() => {
		const full = filePath(resolveWorkspaceB64(userId, dir), path);
		lstatSync(full);
		rmSync(full, { recursive: true });
		return { deleted: true };
	});
}
export function moveEntry(userId: string, dir: string, from: string, to: string) {
	return attempt(() => {
		const root = resolveWorkspaceB64(userId, dir);
		const source = filePath(root, from),
			target = filePath(root, to);
		if (containsPath(source, target)) throw new AppError("BAD_REQUEST", "不能移动到自身或子目录");
		lstatSync(source);
		if (existsSync(target)) throw new AppError("FILE_CONFLICT", "目标已存在，请更换名称");
		mkdirSync(dirname(target), { recursive: true });
		renameSync(source, target);
		return { from, to };
	});
}
export function uploadFiles(
	userId: string,
	dir: string,
	path: string,
	files: Array<{ name: string; contentBase64: string }>,
) {
	return attempt(() => {
		if (!UploadFilesInput.safeParse({ dir, path, files }).success)
			throw new AppError("BAD_REQUEST", "上传参数不合法");
		const root = resolveWorkspaceB64(userId, dir);
		const seen = new Set<string>();
		const entries = files.map((file) => {
			const rel = path ? `${path}/${file.name}` : file.name;
			const full = filePath(root, rel);
			const key = process.platform === "win32" ? full.toLowerCase() : full;
			if (seen.has(key) || existsSync(full))
				throw new AppError("FILE_CONFLICT", `文件重复或已存在：${rel}`);
			seen.add(key);
			const bytes = Buffer.from(file.contentBase64, "base64");
			if (bytes.length > MAX_BYTES) throw new AppError("BAD_REQUEST", `文件超过 1MB：${rel}`);
			return { rel, full, bytes };
		});
		const created: string[] = [];
		try {
			for (const entry of entries) {
				mkdirSync(dirname(entry.full), { recursive: true });
				writeFileSync(entry.full, entry.bytes, { flag: "wx" });
				created.push(entry.full);
			}
		} catch (error) {
			// 回滚本次已创建的文件，不触碰上传前已有的文件。
			for (const full of created) rmSync(full, { force: true });
			throw error;
		}
		return { saved: entries.map((entry) => entry.rel) };
	});
}
