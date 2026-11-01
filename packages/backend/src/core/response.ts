/** 统一响应包装 —— 成功一律 { ok: true, data }，与 @pi-agent/common 的 Ok<T> 同构 */

import type { AppError } from "./app-error";

export function ok<T>(data: T): { ok: true; data: T } {
	return { ok: true, data };
}

export function created<T>(data: T): { ok: true; data: T } {
	return { ok: true, data };
}

export function errorBody(err: AppError): { ok: false; code: string; message: string } {
	return { ok: false, code: err.code, message: err.message };
}
