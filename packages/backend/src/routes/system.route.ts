import {
	AddWorkspaceInput,
	CreateFileInput,
	FileQuery,
	FilesQuery,
	ListDirectoriesQuery,
	MoveFileInput,
	SaveFileInput,
	UploadFilesInput,
} from "@pi-agent/common/dto/requests";
import { Elysia } from "elysia";
import { ok } from "@/core/response";
import { vh } from "@/core/validate";
import { healthInfo } from "@/modules/agent/agent.service";
import { requireUser } from "@/modules/auth/auth.service";
import * as system from "@/modules/system/system.service";
import * as files from "@/modules/system/workspace-files";
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
	})
	.get("/file", ({ query, user }) => {
		const u = requireUser(user);
		const input = vh(FileQuery, query);
		return ok(files.readContent(u.userId, input.dir, input.path));
	})
	.put("/file", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(SaveFileInput, body);
		return ok(files.saveContent(u.userId, input.dir, input.path, input.content, input.revision));
	})
	.post("/file", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(CreateFileInput, body);
		return ok(files.createEntry(u.userId, input.dir, input.path, input.kind));
	})
	.delete("/file", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(FileQuery, body);
		return ok(files.deleteEntry(u.userId, input.dir, input.path));
	})
	.post("/file/move", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(MoveFileInput, body);
		return ok(files.moveEntry(u.userId, input.dir, input.from, input.to));
	})
	.post("/file/upload", ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(UploadFilesInput, body);
		return ok(files.uploadFiles(u.userId, input.dir, input.path, input.files));
	});
