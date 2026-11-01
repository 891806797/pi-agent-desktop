/** Elysia 通用错误边界，业务与鉴权由各自模块和路由接入。 */

import { Elysia } from "elysia";
import { AppError } from "./app-error";
import { errorBody } from "./response";

/** 根应用：onError 统一兜底（AppError → 状态码 + 错误码；其余 500） */
export function createApp() {
	return new Elysia().onError({ as: "global" }, ({ error, code, set }) => {
		if (error instanceof AppError) {
			set.status = error.status;
			return errorBody(error);
		}
		if (code === "NOT_FOUND") {
			set.status = 404;
			return { ok: false, code: "NOT_FOUND", message: "资源不存在" };
		}
		if (code === "VALIDATION" || code === "PARSE") {
			set.status = 400;
			return { ok: false, code: "BAD_REQUEST", message: "请求格式不合法" };
		}
		console.error("[unhandled]", error);
		set.status = 500;
		return { ok: false, code: "INTERNAL", message: "服务器内部错误" };
	});
}
