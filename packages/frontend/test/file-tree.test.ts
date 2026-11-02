import { expect, test } from "bun:test";
import { buildTree } from "../src/components/chat/file-tree-actions";

test("workspace file contract builds a sorted tree including empty directories", () => {
	const tree = buildTree([
		{ path: "z.ts", name: "z.ts", isDir: false },
		{ path: "src/a.ts", name: "a.ts", isDir: false },
		{ path: "empty", name: "empty", isDir: true },
		{ path: "src", name: "src", isDir: true },
	]);
	expect(tree.map((entry) => entry.path)).toEqual(["empty", "src", "z.ts"]);
	expect(tree[0]!.children).toEqual([]);
	expect(tree[1]!.children[0]!.path).toBe("src/a.ts");
});
