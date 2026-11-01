import { ERROR_CODES, type ErrorCode } from "./error-codes";

/** 业务失败统一异常：service 层 raise，route 层不感知 HTTP 语义 */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	/** 覆盖默认 message（携带具体原因） */
	readonly detail?: string;

	constructor(code: ErrorCode, detail?: string) {
		const preset = ERROR_CODES[code];
		super(detail ?? preset.message);
		this.name = "AppError";
		this.code = code;
		this.status = preset.status;
		this.detail = detail;
	}
}
