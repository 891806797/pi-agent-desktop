import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insidePath } from "@/modules/system/paths";

const root = mkdtempSync(join(tmpdir(), "pi-paths-"));
const base = join(root, "project");
const outside = join(root, "project-extra");
mkdirSync(base);
mkdirSync(outside);
symlinkSync(outside, join(base, "escape"), "junction");
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("insidePath", () => {
	test("接受正常文件与不存在的子路径", () => {
		expect(insidePath(base, "ok.txt")).toBe(join(base, "ok.txt"));
		expect(insidePath(base, "new/child.txt")).toBe(join(base, "new/child.txt"));
		expect(insidePath(base, ".")).toBe(base);
	});
	test("拒绝同名前缀的相邻目录", () => {
		expect(() => insidePath(base, "../project-extra/secret.txt")).toThrow("路径越界");
	});
	test("拒绝符号链接下不存在的越界文件", () => {
		expect(() => insidePath(base, "escape/new.txt")).toThrow("路径越界");
	});
});
