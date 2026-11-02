/**
 * 错误码注册表 —— 只追加不改语义。
 * code 稳定供前端分支，message 面向用户。
 */

export const ERROR_CODES = {
	UNAUTHORIZED: { status: 401, message: "未登录或登录已过期" },
	FORBIDDEN: { status: 403, message: "无权访问" },
	NOT_FOUND: { status: 404, message: "资源不存在" },
	VALIDATION_FAILED: { status: 400, message: "参数校验失败" },
	BAD_REQUEST: { status: 400, message: "请求不合法" },
	FILE_CONFLICT: { status: 409, message: "文件已存在或内容已变更" },
	SESSION_EXISTS: { status: 409, message: "会话已存在" },
	SESSION_BUSY: { status: 409, message: "会话正忙" },
	SESSION_DELETED: { status: 410, message: "会话已删除或正在删除" },
	CURSOR_EXPIRED: { status: 409, message: "会话列表已更新，请重新加载" },
	QUOTA_EXCEEDED: { status: 429, message: "活跃会话数超出配额" },
	WORKSPACE_DENIED: { status: 403, message: "工作空间不在白名单内" },
	MODEL_NOT_FOUND: { status: 404, message: "模型不存在或未配置认证" },
	AGENT_ERROR: { status: 500, message: "智能体内部错误" },
	INTERNAL: { status: 500, message: "服务器内部错误" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
