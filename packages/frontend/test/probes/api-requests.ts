import { expect } from "bun:test";
import * as api from "../../src/lib/api";
import { useAuthStore } from "../../src/stores/auth";

const pending: Array<{ path: string; method: string; resolve: (response: Response) => void }> = [];
Object.assign(globalThis, {
	fetch: (path: string, init: RequestInit) =>
		new Promise<Response>((resolve) =>
			pending.push({ path, method: init.method ?? "GET", resolve }),
		),
	location: { pathname: "/chat", search: "?workspace=w&sessionId=s" },
});
useAuthStore.getState().setUsername("one");
const response = (value: unknown = { models: [] }) => Response.json({ ok: true, data: value });
const a = api.listModels();
const b = api.listModels();
expect(pending.length).toBe(1);
pending[0]!.resolve(response());
await Promise.all([a, b]);
const c = api.listModels();
expect(pending.length).toBe(2);
const write = api.putSettingsModels({ providers: {} });
const d = api.listModels();
expect(pending.length).toBe(4);
pending[1]!.resolve(response());
await c;
const joined = api.listModels();
expect(pending.length).toBe(4);
pending[2]!.resolve(response());
pending[3]!.resolve(response());
await Promise.all([write, d, joined]);
const e = api.listModels();
useAuthStore.getState().setUsername("two");
const f = api.listModels();
expect(pending.length).toBe(6);
pending[4]!.resolve(response());
pending[5]!.resolve(response());
await Promise.all([e, f]);
const h1 = api.history({ sessionId: "a", workspace: "w" });
const h2 = api.history({ sessionId: "a", workspace: "w" });
expect(pending.length).toBe(8);
pending[6]!.resolve(response());
pending[7]!.resolve(response());
await Promise.all([h1, h2]);
const failed = api.listWorkspaces();
const sameFailure = api.listWorkspaces();
expect(pending.length).toBe(9);
pending[8]!.resolve(
	Response.json({ ok: false, code: "FAILED", message: "retry" }, { status: 500 }),
);
expect((await Promise.allSettled([failed, sameFailure])).map((item) => item.status)).toEqual([
	"rejected",
	"rejected",
]);
const retry = api.listWorkspaces();
expect(pending.length).toBe(10);
pending[9]!.resolve(response({ workspaces: [] }));
await retry;
const changing = api.putSettingsModels({ providers: {} });
const duringWrite = api.listModels();
expect(pending.length).toBe(12);
pending[10]!.resolve(response());
await changing;
const afterWrite = api.listModels();
expect(pending.length).toBe(13);
pending[11]!.resolve(response({ models: [{ modelId: "old" }] }));
pending[12]!.resolve(response({ models: [{ modelId: "new" }] }));
expect((await duringWrite).models[0]!.modelId).toBe("old");
expect((await afterWrite).models[0]!.modelId).toBe("new");
