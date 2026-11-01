/**
 * auth 路由 —— 登录（JWT httpOnly cookie）/ 登出 / me。
 */

import { LoginInput } from "@pi-agent/common/dto/requests";
import { Elysia } from "elysia";
import { ok } from "@/core/response";
import { vh } from "@/core/validate";
import { env } from "@/env";
import { loginUser, requireUser } from "@/modules/auth/auth.service";
import { AUTH_COOKIE } from "@/modules/auth/token";
import { authContext } from "./auth.middleware";

export const authRoutes = new Elysia({ prefix: "/api/auth" })
	.use(authContext)
	.post("/login", async ({ body, cookie }) => {
		// LoginInput 即 common 里的 zod schema 单源（运行时校验 + 类型）
		const input = vh(LoginInput, body);
		const { username, token } = await loginUser(input.username, input.password);
		cookie[AUTH_COOKIE].set({
			value: token,
			httpOnly: true,
			sameSite: "lax",
			path: "/",
			maxAge: env.tokenTtlSec,
		});
		return ok({ username });
	})
	.post("/logout", ({ cookie }) => {
		cookie[AUTH_COOKIE].remove();
		return ok({ username: "" });
	})
	.get("/me", ({ user }) => {
		const u = requireUser(user);
		return ok({ username: u.username });
	});
