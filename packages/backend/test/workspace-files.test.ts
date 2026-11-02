import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePath, UploadFilesInput } from "@pi-agent/common/dto/requests";
import { env } from "../src/env";
import { expandFileReferences } from "../src/modules/system/file-references";
import { encodePath } from "../src/modules/system/paths";
import * as files from "../src/modules/system/workspace-files";
import { addWorkspace } from "../src/modules/system/workspace-registry";

test("file path contract rejects traversal, absolute paths and Windows aliases", () => {
	for (const path of ["../x", "/x", "C:/x", "x/../y", "x\\y", "nul.txt", "x.", "x//y", "."])
		expect(FilePath.safeParse(path).success).toBe(false);
	expect(FilePath.safeParse("中文目录/hello world.ts").success).toBe(true);
});

test("workspace file lifecycle preserves data, isolates users and rejects unsafe operations", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-files-"));
	const previous = { data: env.dataDir, roots: env.workspaceRoots };
	(env as { dataDir: string }).dataDir = join(temp, "data");
	(env as { workspaceRoots: string[] }).workspaceRoots = [];
	const root = join(temp, "workspace"),
		outside = join(temp, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	const dir = encodePath(root);
	try {
		addWorkspace("files-owner", root);
		expect(() => files.createEntry("other-user", dir, "secret.txt", "file")).toThrow();
		files.createEntry("files-owner", dir, "empty", "dir");
		files.createEntry("files-owner", dir, "nested/test.txt", "file");
		const original = files.readContent("files-owner", dir, "nested/test.txt");
		files.saveContent("files-owner", dir, "nested/test.txt", "你好", original.revision);
		expect(readFileSync(join(root, "nested/test.txt"), "utf8")).toBe("你好");
		expect(() =>
			files.saveContent("files-owner", dir, "nested/test.txt", "stale", original.revision),
		).toThrow();
		expect(() => files.createEntry("files-owner", dir, "nested/test.txt", "file")).toThrow();
		files.moveEntry("files-owner", dir, "nested", "moved");
		expect(files.readContent("files-owner", dir, "moved/test.txt").content).toBe("你好");
		expect(() => files.moveEntry("files-owner", dir, "moved", "moved/child")).toThrow();
		expect(() => files.moveEntry("files-owner", dir, "moved", "empty")).toThrow();
		expect(() => files.deleteEntry("files-owner", dir, ".")).toThrow();
		expect(() => files.createEntry("files-owner", dir, "../escape", "file")).toThrow();
		symlinkSync(outside, join(root, "escape"), "junction");
		expect(() => files.createEntry("files-owner", dir, "escape/oops.txt", "file")).toThrow();
		writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
		expect(() => files.readContent("files-owner", dir, "binary")).toThrow();
		writeFileSync(join(root, "big"), Buffer.alloc(1_048_577, 97));
		expect(() => files.readContent("files-owner", dir, "big")).toThrow();
		expect(() =>
			files.uploadFiles("files-owner", dir, "", [
				{ name: "new", contentBase64: "YQ==" },
				{ name: "big", contentBase64: "Yg==" },
			]),
		).toThrow();
		expect(() => readFileSync(join(root, "new"))).toThrow();
		files.uploadFiles("files-owner", dir, "uploads", [
			{ name: "hello.txt", contentBase64: Buffer.from("世界").toString("base64") },
		]);
		expect(readFileSync(join(root, "uploads/hello.txt"), "utf8")).toBe("世界");
		expect(expandFileReferences("请看 @uploads", root).text).toContain("hello.txt");
		expect(expandFileReferences("请看 @uploads", root).text).toContain("<directory");
		expect(
			UploadFilesInput.safeParse({ dir, path: "", files: [{ name: "x", contentBase64: "!!!" }] })
				.success,
		).toBe(false);
		files.deleteEntry("files-owner", dir, "moved");
		expect(() => files.readContent("files-owner", dir, "moved/test.txt")).toThrow();
	} finally {
		(env as { dataDir: string }).dataDir = previous.data;
		(env as { workspaceRoots: string[] }).workspaceRoots = previous.roots;
		rmSync(temp, { recursive: true, force: true });
	}
});
