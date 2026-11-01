/**
 * vh —— zod 校验薄封装。
 * 失败抛 AppError('VALIDATION_FAILED')，由 create-app 统一兜底成响应。
 */

import type { z } from "zod";
import { AppError } from "./app-error";

export function vh<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
	const result = schema.safeParse(input);
	if (!result.success) {
		const issue = result.error.issues[0];
		throw new AppError(
			"VALIDATION_FAILED",
			`参数校验失败：${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`,
		);
	}
	return result.data;
}
