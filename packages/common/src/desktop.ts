/** 桌面宿主的通信契约；业务请求和 SSE 数据继续使用既有契约。 */
export interface DesktopReady {
	type: "ready";
	protocol: 1;
	url: string;
	version: string;
}
export interface DesktopHostStatus {
	status: "starting" | "ready" | "failed" | "stopping";
	error?: string;
}
export interface DesktopHttpRequest {
	path: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
}
export interface DesktopHttpResponse {
	status: number;
	body: string;
}
export interface DesktopStreamFrame {
	name: string;
	data?: string;
	lastEventId?: string;
}
export interface DesktopNavigation {
	workspace: string;
	sessionId: string;
}

export interface DesktopNotificationWarning {
	message: string;
}
