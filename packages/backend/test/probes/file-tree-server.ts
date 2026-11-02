import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/core/create-app";
import { env } from "../../src/env";
import { signToken } from "../../src/modules/auth/token";
import { encodePath } from "../../src/modules/system/paths";
import { addWorkspace } from "../../src/modules/system/workspace-registry";
import { systemRoutes } from "../../src/routes/system.route";

const root = mkdtempSync(join(tmpdir(), "pi-file-browser-"));
(env as { dataDir: string }).dataDir = join(root, "data");
(env as { workspaceRoots: string[] }).workspaceRoots = [];
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src/hello.ts"), 'export const hello = "world";');
addWorkspace("browser-files", workspace);
const token = await signToken({ userId: "browser-files", username: "browser-files" });
const app = createApp().use(systemRoutes).listen({ port: 0, hostname: "127.0.0.1" });
writeFileSync(
	process.argv[2]!,
	JSON.stringify({ root, workspace, dir: encodePath(workspace), token, port: app.server!.port }),
);
console.log("file browser fixture ready");
