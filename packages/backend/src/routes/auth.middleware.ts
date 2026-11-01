import { Elysia } from "elysia";
import { AUTH_COOKIE, verifyToken } from "@/modules/auth/token";

/** Cookie 属于 HTTP 接入层，认证判断交给 auth 模块。 */
export const authContext = new Elysia({ name: "auth-context" }).derive(
	{ as: "global" },
	async ({ cookie }) => {
		const token = cookie[AUTH_COOKIE]?.value as string | undefined;
		return { user: token ? await verifyToken(token) : null };
	},
);
