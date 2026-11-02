import { AddWorkspaceInput, FilesQuery, ListDirectoriesQuery } from "@pi-agent/common/dto/requests";
import { Elysia } from "elysia";
import { ok } from "@/core/response";
import { vh } from "@/core/validate";
import { healthInfo } from "@/modules/agent/agent.service";
import { requireUser } from "@/modules/auth/auth.service";
import * as system from "@/modules/system/system.service";
import { authContext } from "./auth.middleware";

export const systemRoutes = new Elysia({ prefix: "/api" })
	.use(authContext)
	.get("/health", () => ok(healthInfo()))
	.get("/workspaces", ({ user }) => {
		return ok({ workspaces: system.workspaceList(requireUser(user).userId) });
	})
	.post("/workspaces", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(AddWorkspaceInput, body);
		return ok({ workspace: system.registerWorkspace(u.userId, input.path) });
	})
	.get("/fs/dirs", ({ query, user }) => {
		requireUser(user);
		return ok(system.listDirectories(vh(ListDirectoriesQuery, query).path));
	})
	.get("/files", ({ query, user }) => {
		const u = requireUser(user);
		const input = vh(FilesQuery, query);
		return ok({ files: system.listFiles(u.userId, input.dir, input.q) });
	});
