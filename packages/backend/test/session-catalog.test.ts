import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../src/modules/agent/session-catalog";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-catalog-"));
	const file = join(dir, "runtime.sqlite");
	const catalog = new SessionCatalog(file);
	return {
		catalog,
		file,
		close: () => {
			catalog.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
const summary = (sessionId: string) => ({
	sessionId,
	workspace: "D:/project",
	firstMessage: sessionId,
	createdAt: new Date(1000).toISOString(),
});

test("catalog includes empty sessions, isolates owners and preserves archive across reopen", () => {
	const f = fixture();
	try {
		f.catalog.upsert("u", summary("one"));
		expect(f.catalog.list("other").sessions).toEqual([]);
		const row = f.catalog.list("u").sessions[0]!;
		expect(row.sessionId).toBe("one");
		f.catalog.update("u", "one", row.revision, { archived: true });
		expect(f.catalog.list("u").sessions).toEqual([]);
		const next = new SessionCatalog(f.file);
		try {
			expect(next.list("u", { archived: true }).sessions).toHaveLength(1);
		} finally {
			next.close();
		}
	} finally {
		f.close();
	}
});

test("catalog rejects stale management and pagination; literal search cannot match unrelated rows", () => {
	const f = fixture();
	try {
		for (const id of ["one", "two", "three"]) f.catalog.upsert("u", summary(id));
		const first = f.catalog.list("u", { limit: 1 });
		expect(first.nextCursor).toBeTruthy();
		const second = f.catalog.list("u", { limit: 1, cursor: first.nextCursor! });
		expect(second.sessions[0]!.sessionId).not.toBe(first.sessions[0]!.sessionId);
		const row = first.sessions[0]!;
		f.catalog.update("u", row.sessionId, row.revision, { name: "new" });
		expect(() => f.catalog.update("u", row.sessionId, row.revision, { archived: true })).toThrow();
		expect(() => f.catalog.list("u", { limit: 1, cursor: first.nextCursor! })).toThrow(
			"列表已更新",
		);
		expect(f.catalog.list("u", { q: "%" }).sessions).toEqual([]);
		expect(f.catalog.list("u", { q: "new" }).sessions).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("archived approvals remain in attention; marking read cannot clear pending or a newer notice", () => {
	const f = fixture();
	try {
		f.catalog.upsert("u", summary("one"));
		let row = f.catalog.get("u", "one")!;
		f.catalog.update("u", "one", row.revision, { archived: true });
		f.catalog.project("u", "one", {
			status: "awaiting-approval",
			pendingPermissions: 1,
			pendingQuestions: 0,
			live: true,
		});
		row = f.catalog.notify("u", "one", "attention");
		const previous = row.noticeVersion;
		f.catalog.notify("u", "one", "failed");
		f.catalog.markRead("u", "one", previous);
		const snapshot = f.catalog.list("u");
		expect(snapshot.attention[0]!.pendingPermissions).toBe(1);
		expect(snapshot.attention[0]!.noticeVersion).toBeGreaterThan(
			snapshot.attention[0]!.readVersion,
		);
	} finally {
		f.close();
	}
});

test("deletion tombstones block reconciliation and stale resume, retaining no chat metadata", () => {
	const f = fixture();
	try {
		f.catalog.upsert("u", summary("one"));
		const row = f.catalog.get("u", "one")!;
		f.catalog.beginDelete("u", "one", row.revision);
		expect(() => f.catalog.assertAvailable("u", "one")).toThrow("已删除");
		f.catalog.finishDelete("u", "one");
		f.catalog.upsert("u", summary("one"));
		expect(f.catalog.list("u").sessions).toEqual([]);
		expect(f.catalog.get("u", "one")!.firstMessage).toBe("");
	} finally {
		f.close();
	}
});

test("finishing a previously paused deletion invalidates pagination exactly once", () => {
	const f = fixture();
	try {
		for (const id of ["one", "two", "three"]) f.catalog.upsert("u", summary(id));
		const row = f.catalog.require("u", "two");
		f.catalog.beginDelete("u", row.sessionId, row.revision);
		const page = f.catalog.list("u", { limit: 1 });
		f.catalog.finishDelete("u", row.sessionId);
		expect(() => f.catalog.list("u", { limit: 1, cursor: page.nextCursor! })).toThrow("列表已更新");
		const version = f.catalog.list("u").listVersion;
		f.catalog.finishDelete("u", row.sessionId);
		expect(f.catalog.list("u").listVersion).toBe(version);
	} finally {
		f.close();
	}
});
