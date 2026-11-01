import type {
	AgentStatus,
	ChatMessage,
	PendingRequest,
	RunMode,
	SessionCloseReason,
	SlashCommand,
} from "@pi-agent/common";
import type { ApprovalActionInput } from "@pi-agent/common/dto/requests";

/** 编辑器附件只用于浏览器输入，消息与审批直接使用 common 契约。 */
export type Attachment =
	| { type: "file"; path: string }
	| { type: "image"; dataUrl: string; mime: string; filename?: string };

export interface ChatAgentApi {
	messages: ChatMessage[];
	projectId: string | null;
	status: AgentStatus;
	isRunning: boolean;
	isCompacting: boolean;
	isSwitchingSession: boolean;
	lastError: string | null;
	sessionId: string | null;
	closed: { reason: SessionCloseReason } | null;
	approvalRequests: PendingRequest[];
	commands: SlashCommand[];
	runMode: RunMode;
	runModeLabel: string;
	selectRunMode: (mode: RunMode) => Promise<void>;
	sendMessage: (
		text: string,
		attachments?: Attachment[],
		behavior?: "steer" | "followUp",
	) => Promise<boolean>;
	interruptRun: () => void;
	approve: (
		requestId: string,
		action: ApprovalActionInput["action"],
		data?: unknown,
	) => Promise<void>;
}
