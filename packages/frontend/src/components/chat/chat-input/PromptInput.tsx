import {
	formatModelName,
	type ModelRef,
	type RunMode,
	type SlashCommand,
	type ThinkingLevel,
} from "@pi-agent/common";
import { ArrowUpIcon, FileIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueueBar } from "@/components/input/QueueBar";
import type { Attachment } from "@/lib/agent-types";
import * as api from "@/lib/api";
import { updatePreferences } from "@/lib/default-settings";
import { useChatStore } from "@/stores/chat";
import { CommandPopover } from "./CommandPopover";
import {
	createChipSpan,
	createImageChipSpan,
	extendRangeToAt,
	extendRangeToSlash,
	getChipBeforeCaret,
	getTextBeforeCaret,
	parseDOMToParts,
	partsToWire,
	submitDraft,
} from "./dom";
import { MentionPopover } from "./MentionPopover";
import { ModelSelectorPopover } from "./ModelSelectorPopover";
import type { FileSearchHit, ImageMime } from "./types";

export interface PromptInputProps {
	isRunning: boolean;
	/** 会话切换中（resume/openNew）：锁发送防竞态（消息打到正在替换的进程会蒸发） */
	isSwitchingSession: boolean;
	commands: SlashCommand[];
	/** 当前项目 id（文件搜索数据源）；null 时禁用文件引用 */
	projectId?: string | null;
	/** 当前执行模式（store 单一事实源） */
	runMode: RunMode;
	/** 执行模式显示名 */
	runModeLabel: string;
	/** 活会话热切换；新会话保留选择，创建后应用。 */
	onSelectRunMode: (mode: RunMode) => void;
	onSend: (
		message: string,
		attachments: Attachment[],
		behavior?: "steer" | "followUp",
	) => Promise<boolean>;
	/** 中断当前进行中的 turn（保活会话） */
	onInterrupt: () => void;
}

/** 粗指针（触屏）设备：Enter 换行、发送只走按钮（无物理键盘的 Enter 语义不可靠） */
function isCoarsePointer(): boolean {
	return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** 高频命令白名单：空 query 时排最前；不在名单内的命令仍显示，仅排序靠后 */
const HIGH_FREQ_COMMANDS = new Set(["new", "compact"]);

function scoreCmd(cmd: SlashCommand, query: string): number {
	const name = cmd.name.toLowerCase();
	if (!query) return HIGH_FREQ_COMMANDS.has(name) ? 3000 : cmd.source === "extension" ? 2000 : 1000;
	if (name === query) return 2000;
	if (name.startsWith(query)) return 1000 - name.length;
	const index = name.indexOf(query);
	if (index > 0) return 600 - index - name.length * 0.1;
	return (cmd.description ?? "").toLowerCase().includes(query) ? 100 : 0;
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.length > 4096 ? bytes.subarray(0, 4096) : bytes;
	let control = 0;
	for (let i = 0; i < sample.length; i++) {
		const b = sample[i];
		if (b === 0) return true;
		if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
	}
	return sample.length > 0 && control / sample.length > 0.3;
}

function normalizeImageMime(mime: string): ImageMime | null {
	const m = mime.toLowerCase();
	if (m === "image/jpg") return "image/jpeg";
	if (m === "image/png" || m === "image/jpeg" || m === "image/gif" || m === "image/webp")
		return m as ImageMime;
	return null;
}

function readAsDataURL(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function basename(p: string): string {
	return p.split(/[/\\]/).pop() ?? p;
}

const SEND_MODES = [
	{ value: "followUp", label: "排队发送", description: "当前任务结束后自动发送" },
	{ value: "steer", label: "直接发送", description: "不停止当前运行，尽快处理" },
];

const showError = (err: unknown) => useChatStore.setState({ lastError: String(err) });

export function PromptInput(props: PromptInputProps): React.JSX.Element {
	const {
		isRunning,
		isSwitchingSession,
		commands,
		projectId,
		runMode,
		runModeLabel,
		onSelectRunMode,
		onSend,
		onInterrupt,
	} = props;
	const [behavior, setBehavior] = useState<"steer" | "followUp">("followUp");
	const [sendModeOpen, setSendModeOpen] = useState(false);
	const [sendModeQuery, setSendModeQuery] = useState("");
	const [sendModeActive, setSendModeActive] = useState(0);
	const sendModeItems = SEND_MODES.filter(
		(item) =>
			item.label.includes(sendModeQuery.trim()) || item.description.includes(sendModeQuery.trim()),
	);
	const availableThinkingLevels = useChatStore((s) => s.availableThinkingLevels);
	const hasSession = useChatStore((s) => !!s.sessionId);
	const renderedSearch = location.search;
	const rootRef = useRef<HTMLDivElement>(null);
	const draftRevision = useRef(0);
	const pendingSubmission = useRef<{ search: string } | null>(null);
	const [sendingSearch, setSendingSearch] = useState<string | null>(null);
	const isSubmitting = sendingSearch === location.search;
	// 模型/思考强度：直接从 store + api 取（直接消费 SDK 投影状态）
	const model = useChatStore((s) => s.model);
	const thinkingLevel = useChatStore((s) => s.thinkingLevel);
	const [models, setModels] = useState<ModelRef[]>([]);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [modelsError, setModelsError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void api
			.listModels()
			.then((r) => {
				if (!cancelled) setModels(r.models);
			})
			.catch((error) => {
				if (!cancelled) setModelsError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!cancelled) setModelsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	/** 输入框 + 三个 Popover 的外层容器：用于 outside click 关闭 Popover */
	const inputWrapRef = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);
	const searchSeqRef = useRef(0);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [hasText, setHasText] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [mentionOpen, setMentionOpen] = useState(false);
	const [mentionResults, setMentionResults] = useState<FileSearchHit[]>([]);
	const [mentionLoading, setMentionLoading] = useState(false);
	const [mentionActive, setMentionActive] = useState(0);
	/** 文件引用面板触发来源：'at'（输入 @ 触发，无搜索框）/ 'menu'（按钮触发，带搜索框） */
	const [mentionTrigger, setMentionTrigger] = useState<"at" | "menu">("at");
	const [mentionMenuQuery, setMentionMenuQuery] = useState("");
	const [commandOpen, setCommandOpen] = useState(false);
	const [commandQuery, setCommandQuery] = useState("");
	const [commandActive, setCommandActive] = useState(0);
	const [runModeOpen, setRunModeOpen] = useState(false);
	const [runModeQuery, setRunModeQuery] = useState("");
	const [runModeActive, setRunModeActive] = useState(0);
	// 模型/思考 popover 状态（复用 ModelSelectorPopover 组件）
	const [modelOpen, setModelOpen] = useState(false);
	const [modelQuery, setModelQuery] = useState("");
	const [modelActive, setModelActive] = useState(0);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [thinkingQuery, setThinkingQuery] = useState("");
	const [thinkingActive, setThinkingActive] = useState(0);
	const supportedThinkingLevels = hasSession
		? availableThinkingLevels
		: (models.find((item) => item.provider === model?.provider && item.modelId === model.modelId)
				?.supportedThinkingLevels ?? ["off"]);

	const filteredCommands = useMemo(() => {
		const q = commandQuery.trim().toLowerCase();
		const cands: Array<{ cmd: SlashCommand; score: number }> = [];
		for (const c of commands) {
			cands.push({ cmd: c, score: scoreCmd(c, q) });
		}
		return cands
			.filter((x) => !q || x.score > 0 || x.cmd.name.toLowerCase().includes(q))
			.sort((a, b) => {
				// 同分时按字母序，使命令位置稳定可预测（空 query 下尤其重要）
				if (a.score !== b.score) return b.score - a.score;
				return a.cmd.name.localeCompare(b.cmd.name);
			})
			.slice(0, 50)
			.map((x) => x.cmd);
	}, [commands, commandQuery]);

	const runModeItems = useMemo<
		Array<{ value: RunMode; label: string; description: string }>
	>(() => {
		const q = runModeQuery.trim().toLowerCase();
		const all: Array<{ value: RunMode; label: string; description: string }> = [
			{
				value: "auto",
				label: "全自动模式",
				description: "无人值守，工具全放行，AskUserQuestion 自主决断",
			},
			{ value: "standard", label: "标准模式", description: "仅问卷走审批，命令/写文件直通" },
			{ value: "safe", label: "安全模式", description: "命令 + 写文件 + 问卷均须审批" },
			{ value: "plan", label: "计划模式", description: "只读模式，不执行任何工具，仅规划" },
		];
		return q
			? all.filter(
					(it) => it.label.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
				)
			: all;
	}, [runModeQuery]);

	// 模型列表 items（ModelSelectorPopover 消费）
	const modelItems = useMemo(() => {
		const q = modelQuery.trim().toLowerCase();
		return models
			.map((m) => ({
				value: `${m.provider}/${m.modelId}`,
				label: formatModelName(m),
				description: m.provider,
			}))
			.filter(
				(it) =>
					!q || it.label.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
			);
	}, [models, modelQuery]);

	const currentModelLabel =
		!modelsLoading && models.length === 0
			? "无可用模型"
			: model
				? formatModelName(model)
				: "选择模型";

	// 思考强度 items
	const thinkingItems = useMemo(() => {
		const all = [
			{ value: "minimal", label: "最少", description: "最少量思考" },
			{ value: "off", label: "关闭", description: "不输出思考过程" },
			{ value: "low", label: "低", description: "少量思考" },
			{ value: "medium", label: "中", description: "适度思考" },
			{ value: "high", label: "高", description: "深度思考" },
			{ value: "xhigh", label: "极高", description: "极致思考" },
			{ value: "max", label: "最高", description: "模型支持的最高思考强度" },
		];
		const supported = all.filter((it) =>
			supportedThinkingLevels.includes(it.value as ThinkingLevel),
		);
		const q = thinkingQuery.trim().toLowerCase();
		return q
			? supported.filter(
					(it) => it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q),
				)
			: supported;
	}, [thinkingQuery, supportedThinkingLevels]);

	const adjustHasText = useCallback(() => {
		draftRevision.current++;
		const root = rootRef.current;
		if (!root) return;
		const hasChip = root.querySelector("[data-mention],[data-image]") !== null;
		setHasText((root.textContent ?? "").length > 0 || hasChip);
	}, []);

	const runSearch = useCallback(
		(query: string) => {
			if (!projectId) {
				setMentionResults([]);
				return;
			}
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
			searchTimerRef.current = setTimeout(async () => {
				const seq = ++searchSeqRef.current;
				setMentionLoading(true);
				try {
					// 后端返回相对/绝对路径 string[]（空 q 返回全量），前端映射为 FileSearchHit
					const paths = (await api.listFiles(projectId, query)).files
						.filter((f) => !f.isDir)
						.map((f) => f.path);
					if (seq === searchSeqRef.current) {
						setMentionResults(
							paths
								.slice(0, 50)
								.map((p) => ({ path: p, name: basename(p), relativePath: p, score: 0 })),
						);
						setMentionActive(0);
					}
				} catch {
					if (seq === searchSeqRef.current) setMentionResults([]);
				} finally {
					if (seq === searchSeqRef.current) setMentionLoading(false);
				}
			}, 80);
		},
		[projectId],
	);

	const detectTrigger = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const before = getTextBeforeCaret(root);
		const atMatch = before.match(/(?:^|\s)@([^\s@]*)$/);
		if (atMatch) {
			setMentionTrigger("at");
			setMentionOpen(true);
			setMentionActive(0);
			setCommandOpen(false);
			void runSearch(atMatch[1]);
			return;
		}
		const slashMatch = before.match(/(?:^|\n)\/([^\s/]*)$/);
		if (slashMatch) {
			setCommandOpen(true);
			setCommandQuery(slashMatch[1]);
			setCommandActive(0);
			setMentionOpen(false);
			return;
		}
		// 非 @/ 输入：仅 at 模式才关文件面板（menu 模式由搜索框/按钮自行管理，不误关）
		setCommandOpen(false);
		if (mentionTrigger === "at") setMentionOpen(false);
	}, [runSearch, mentionTrigger]);

	const handleInput = useCallback(
		(_e: React.SyntheticEvent) => {
			if (composingRef.current) return;
			adjustHasText();
			detectTrigger();
		},
		[adjustHasText, detectTrigger],
	);

	const insertChipAtCaret = useCallback(
		(chip: HTMLElement): void => {
			const root = rootRef.current;
			if (!root) return;
			root.focus();
			const sel = window.getSelection();
			const space = document.createTextNode(" ");
			if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).endContainer)) {
				root.appendChild(chip);
				root.appendChild(space);
			} else {
				const range = sel.getRangeAt(0);
				range.deleteContents();
				range.insertNode(space);
				range.insertNode(chip);
				const nr = document.createRange();
				nr.setStartAfter(space);
				nr.collapse(true);
				sel.removeAllRanges();
				sel.addRange(nr);
			}
			adjustHasText();
		},
		[adjustHasText],
	);

	const insertTextAtCaret = useCallback(
		(text: string): void => {
			const root = rootRef.current;
			if (!root) return;
			root.focus();
			document.execCommand("insertText", false, text);
			adjustHasText();
		},
		[adjustHasText],
	);

	const addMention = useCallback(
		(hit: FileSearchHit): void => {
			const root = rootRef.current;
			if (!root) return;
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return;
			const range = sel.getRangeAt(0).cloneRange();
			if (!extendRangeToAt(range)) {
				insertChipAtCaret(createChipSpan(hit.path, hit.name));
				setMentionOpen(false);
				return;
			}
			range.deleteContents();
			const chip = createChipSpan(hit.path, hit.name);
			const space = document.createTextNode(" ");
			range.insertNode(space);
			range.insertNode(chip);
			const nr = document.createRange();
			nr.setStartAfter(space);
			nr.collapse(true);
			sel.removeAllRanges();
			sel.addRange(nr);
			setMentionOpen(false);
			root.focus();
			adjustHasText();
		},
		[insertChipAtCaret, adjustHasText],
	);

	const submit = useCallback(async (): Promise<void> => {
		const root = rootRef.current;
		if (!root || isSwitchingSession || pendingSubmission.current?.search === location.search)
			return;
		const revision = draftRevision.current;
		const operation = { search: location.search };
		pendingSubmission.current = operation;
		setSendingSearch(operation.search);
		try {
			const { message, attachments } = partsToWire(parseDOMToParts(root));
			if (!message && attachments.length === 0) return;
			const cleared = await submitDraft(
				root,
				() => onSend(message, attachments, behavior),
				() => rootRef.current === root && draftRevision.current === revision,
			);
			if (cleared) {
				setMentionOpen(false);
				setCommandOpen(false);
				setHasText(false);
				root.focus();
			}
		} catch (err) {
			if (rootRef.current === root && location.search === operation.search) showError(err);
		} finally {
			if (pendingSubmission.current === operation) {
				pendingSubmission.current = null;
				setSendingSearch(null);
			}
		}
	}, [onSend, isSwitchingSession, behavior]);

	const insertCommand = useCallback(
		(cmd: SlashCommand): void => {
			const root = rootRef.current;
			if (!root) return;
			root.focus();
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return;
			const range = sel.getRangeAt(0).cloneRange();
			if (extendRangeToSlash(range)) range.deleteContents();
			const text = document.createTextNode(`/${cmd.name} `);
			range.insertNode(text);
			const nr = document.createRange();
			nr.setStartAfter(text);
			nr.collapse(true);
			sel.removeAllRanges();
			sel.addRange(nr);
			setCommandOpen(false);
			adjustHasText();
			root.focus();
		},
		[adjustHasText],
	);

	const selectRunModeItem = useCallback(
		(value: RunMode): void => {
			onSelectRunMode(value);
			setRunModeOpen(false);
			setRunModeActive(0);
			rootRef.current?.focus();
		},
		[onSelectRunMode],
	);

	const openRunModeSelect = useCallback((): void => {
		setMentionOpen(false);
		setCommandOpen(false);
		setModelOpen(false);
		setThinkingOpen(false);
		setSendModeOpen(false);
		setRunModeOpen(true);
		setRunModeActive(runModeItems.findIndex((it) => it.value === runMode));
	}, [runModeItems, runMode]);

	// 模型选择
	// biome-ignore lint/correctness/useExhaustiveDependencies: URL 变化使旧页面的模型选择回调失效。
	const selectModelItem = useCallback(
		(value: string | undefined) => {
			if (location.search !== renderedSearch) return;
			const search = location.search;
			if (value) {
				const slash = value.indexOf("/");
				const p = value.slice(0, slash);
				const m = value.slice(slash + 1);
				if (p && m)
					void updatePreferences(
						{ model: { provider: p, modelId: m } },
						() => location.search === search,
						() => api.setModel(p, m),
					).catch((err) => {
						if (location.search === search) showError(err);
					});
			}
			setModelOpen(false);
			setModelActive(0);
			rootRef.current?.focus();
		},
		[renderedSearch],
	);

	const openModelSelect = useCallback((): void => {
		setMentionOpen(false);
		setCommandOpen(false);
		setRunModeOpen(false);
		setThinkingOpen(false);
		setSendModeOpen(false);
		setModelOpen(true);
		const cur = model ? `${model.provider}/${model.modelId}` : undefined;
		setModelActive(modelItems.findIndex((it) => it.value === cur));
	}, [modelItems, model]);

	// 思考强度选择
	// biome-ignore lint/correctness/useExhaustiveDependencies: URL 变化使旧页面的思考选择回调失效。
	const selectThinkingItem = useCallback(
		(value: string | undefined) => {
			if (location.search !== renderedSearch) return;
			const search = location.search;
			if (value)
				void updatePreferences(
					{ thinkingLevel: value as ThinkingLevel },
					() => location.search === search,
					() => api.setThinking(value as ThinkingLevel),
				).catch((err) => {
					if (location.search === search) showError(err);
				});
			setThinkingOpen(false);
			setSendModeOpen(false);
			setThinkingActive(0);
			rootRef.current?.focus();
		},
		[renderedSearch],
	);

	const openThinkingSelect = useCallback((): void => {
		setMentionOpen(false);
		setCommandOpen(false);
		setRunModeOpen(false);
		setModelOpen(false);
		setThinkingOpen(true);
		setSendModeOpen(false);
		setThinkingActive(thinkingItems.findIndex((it) => it.value === thinkingLevel));
	}, [thinkingItems, thinkingLevel]);

	const openFileMenu = useCallback((): void => {
		setSendModeOpen(false);
		if (!projectId) return; // 无项目不提供文件引用
		setCommandOpen(false);
		setRunModeOpen(false);
		setMentionTrigger("menu");
		setMentionMenuQuery("");
		setMentionActive(0);
		setMentionOpen(true);
		void runSearch(""); // 列出全部前 50
	}, [projectId, runSearch]);

	/** menu 模式文件搜索框文本变化：更新 query 并重置高亮项 */
	const onMentionSearchQueryChange = useCallback(
		(q: string): void => {
			setMentionMenuQuery(q);
			setMentionActive(0);
			void runSearch(q);
		},
		[runSearch],
	);

	/** menu 模式文件搜索框键盘导航：复用 mentionOpen 分支的导航逻辑 */
	const onMentionSearchKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>): void => {
			if (!mentionOpen) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMentionActive((i) => (i + 1) % Math.max(mentionResults.length, 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMentionActive(
					(i) => (i - 1 + Math.max(mentionResults.length, 1)) % Math.max(mentionResults.length, 1),
				);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const hit = mentionResults[mentionActive];
				if (hit) addMention(hit);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMentionOpen(false);
			}
		},
		[mentionOpen, mentionResults, mentionActive, addMention],
	);

	const removeChipBeforeCaret = useCallback((): void => {
		const root = rootRef.current;
		if (!root) return;
		const chip = getChipBeforeCaret(root);
		if (chip) {
			chip.remove();
			adjustHasText();
		}
	}, [adjustHasText]);

	const ingestDroppedFiles = useCallback(
		async (files: File[]): Promise<void> => {
			for (const file of files) {
				const mime = file.type;
				if (mime.startsWith("image/")) {
					const normalized = normalizeImageMime(mime);
					if (!normalized) continue;
					const dataUrl = await readAsDataURL(file);
					insertChipAtCaret(createImageChipSpan(dataUrl, file.name));
				} else {
					try {
						const buf = await file.arrayBuffer();
						const bytes = new Uint8Array(buf);
						if (looksBinary(bytes)) continue;
						const limit = 10240;
						const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit));
						insertTextAtCaret(text.length >= limit ? `${text}\n…[truncated]` : text);
					} catch {
						/* 忽略不可读文件 */
					}
				}
			}
		},
		[insertChipAtCaret, insertTextAtCaret],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>): void => {
			if (runModeOpen && runModeItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setRunModeActive((i) => (i + 1) % runModeItems.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setRunModeActive((i) => (i - 1 + runModeItems.length) % runModeItems.length);
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					const item = runModeItems[runModeActive];
					if (item) selectRunModeItem(item.value);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setRunModeOpen(false);
					return;
				}
			}
			if (mentionOpen && mentionResults.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setMentionActive((i) => (i + 1) % mentionResults.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setMentionActive((i) => (i - 1 + mentionResults.length) % mentionResults.length);
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					const hit = mentionResults[mentionActive];
					if (hit) addMention(hit);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setMentionOpen(false);
					return;
				}
			} else if (commandOpen && filteredCommands.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setCommandActive((i) => (i + 1) % filteredCommands.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setCommandActive((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					const cmd = filteredCommands[commandActive];
					if (cmd) insertCommand(cmd);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setCommandOpen(false);
					return;
				}
			} else if (mentionOpen || commandOpen) {
				if (e.key === "Escape") {
					e.preventDefault();
					setMentionOpen(false);
					setCommandOpen(false);
				}
			}
			// 细指针（鼠标/触控板）：Enter 发送、Shift+Enter 换行；
			// 粗指针（触屏）：Enter 换行，发送只走按钮（软键盘 Enter 语义不可靠）
			if (e.key === "Enter" && !e.shiftKey && !isCoarsePointer() && !isSwitchingSession) {
				e.preventDefault();
				submit();
				return;
			}
			if (e.key === "Escape" && isRunning) {
				e.preventDefault();
				onInterrupt();
			}
		},
		[
			runModeOpen,
			runModeItems,
			runModeActive,
			selectRunModeItem,
			mentionOpen,
			mentionResults,
			mentionActive,
			commandOpen,
			filteredCommands,
			commandActive,
			addMention,
			insertCommand,
			submit,
			isRunning,
			isSwitchingSession,
			onInterrupt,
		],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent): void => {
			e.preventDefault();
			const cd = e.clipboardData;
			if (cd.files && cd.files.length > 0) {
				void ingestDroppedFiles(Array.from(cd.files));
				return;
			}
			const text = cd.getData("text/plain");
			if (text.startsWith("file:")) {
				const path = text.slice(5);
				insertChipAtCaret(createChipSpan(path, basename(path)));
				return;
			}
			const imageItem = Array.from(cd.items).find((i) => i.type.startsWith("image/"));
			if (imageItem) {
				const f = imageItem.getAsFile();
				if (f) void ingestDroppedFiles([f]);
				return;
			}
			insertTextAtCaret(text);
		},
		[ingestDroppedFiles, insertChipAtCaret, insertTextAtCaret],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent): void => {
			e.preventDefault();
			setDragOver(false);
			const internal = e.dataTransfer.getData("text/plain");
			if (internal.startsWith("file:")) {
				const path = internal.slice(5);
				insertChipAtCaret(createChipSpan(path, basename(path)));
				return;
			}
			const files = Array.from(e.dataTransfer.files);
			if (files.length > 0) void ingestDroppedFiles(files);
		},
		[insertChipAtCaret, ingestDroppedFiles],
	);

	const handleDragOver = useCallback((e: React.DragEvent): void => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent): void => {
		if (e.currentTarget === e.target) setDragOver(false);
	}, []);

	const handleBeforeInput = useCallback(
		(e: React.FormEvent<HTMLDivElement>): void => {
			const native = e.nativeEvent as InputEvent;
			if (native.inputType === "insertFromPaste") {
				e.preventDefault();
				return;
			}
			if (native.inputType === "deleteContentBackward") {
				const root = rootRef.current;
				if (!root) return;
				const sel = window.getSelection();
				if (sel?.isCollapsed && getChipBeforeCaret(root)) {
					e.preventDefault();
					removeChipBeforeCaret();
				}
			}
		},
		[removeChipBeforeCaret],
	);

	useEffect(() => {
		return () => {
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 项目切换重置触发器
	useEffect(() => {
		searchSeqRef.current++;
		if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		setMentionLoading(false);
		setMentionResults([]);
		setMentionOpen(false);
	}, [projectId]);

	// 点击输入框与 Popover 外部时关闭命令、文件和设置面板。
	useEffect(() => {
		const onPointerDown = (e: MouseEvent): void => {
			const wrap = inputWrapRef.current;
			if (!wrap || wrap.contains(e.target as Node)) return;
			setMentionOpen(false);
			setCommandOpen(false);
			setRunModeOpen(false);
			setModelOpen(false);
			setThinkingOpen(false);
			setSendModeOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, []);

	// 外部注入文件引用（FileTree 单击文件）：window 事件通道 → caret 处插入 @chip
	useEffect(() => {
		const onInsert = (e: Event): void => {
			const path = (e as CustomEvent<string>).detail;
			if (!path) return;
			rootRef.current?.focus();
			insertChipAtCaret(createChipSpan(path, basename(path)));
		};
		window.addEventListener("composer:insert", onInsert);
		return () => window.removeEventListener("composer:insert", onInsert);
	}, [insertChipAtCaret]);

	return (
		<fieldset
			aria-label="消息输入区"
			className="m-0 min-w-0 shrink-0 border-0 px-4 pb-4 pt-2 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:px-2.5"
		>
			<QueueBar key={renderedSearch} />
			<div
				ref={inputWrapRef}
				className={[
					"rounded-[28px] border bg-[var(--bg-layer-01)] shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-all relative",
					dragOver
						? "border-primary shadow-[0_2px_16px_rgba(0,0,0,0.08)]"
						: "border-[var(--border-base)] focus-within:border-ring focus-within:shadow-[0_2px_16px_rgba(0,0,0,0.08)]",
				].join(" ")}
			>
				{dragOver && (
					<div className="absolute inset-0 z-30 grid place-items-center rounded-[28px] bg-[var(--bg-base)]/80 text-[14px] text-[var(--text-muted)] pointer-events-none">
						拖放以附加文件
					</div>
				)}
				<MentionPopover
					open={mentionOpen}
					results={mentionResults}
					loading={mentionLoading}
					activeIndex={mentionActive}
					onSelect={addMention}
					onHover={setMentionActive}
					searchMode={mentionTrigger === "menu"}
					searchQuery={mentionMenuQuery}
					onSearchQueryChange={onMentionSearchQueryChange}
					onSearchKeyDown={onMentionSearchKeyDown}
				/>
				<CommandPopover
					open={commandOpen}
					commands={filteredCommands}
					activeIndex={commandActive}
					onSelect={insertCommand}
					onHover={setCommandActive}
				/>
				<div className="px-5 pt-4 pb-1">
					{/* biome-ignore lint/a11y/useSemanticElements: contentEditable 富文本，需承载 HTML chips */}
					{/* biome-ignore lint/a11y/useFocusableInteractive: contentEditable 原生可聚焦 */}
					<div
						ref={rootRef}
						contentEditable
						suppressContentEditableWarning
						role="textbox"
						aria-multiline="true"
						data-placeholder={
							isSwitchingSession
								? "会话切换中，请稍后输入"
								: isRunning && behavior === "followUp"
									? "继续输入，回车加入待发送队列"
									: "给助手发消息"
						}
						onInput={handleInput}
						onKeyDown={handleKeyDown}
						onCompositionStart={() => {
							composingRef.current = true;
						}}
						onCompositionEnd={(e) => {
							composingRef.current = false;
							handleInput(e);
						}}
						onPaste={handlePaste}
						onDrop={handleDrop}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onBeforeInput={handleBeforeInput}
						className="prompt-editor w-full resize-none bg-transparent text-[15px] leading-6 text-[var(--text-base)] outline-none max-h-[200px] max-md:max-h-[35dvh] overflow-y-auto"
					/>
				</div>
				<div className="relative flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
					<ModelSelectorPopover
						open={runModeOpen}
						loading={false}
						items={runModeItems}
						selectedValue={runMode}
						query={runModeQuery}
						activeIndex={runModeActive}
						onSelect={(v) => {
							if (v) selectRunModeItem(v as RunMode);
						}}
						onQueryChange={setRunModeQuery}
						onHover={setRunModeActive}
						searchPlaceholder="搜索模式…"
						onClose={() => setRunModeOpen(false)}
						loadingText="加载模式中…"
						emptyText="无匹配模式"
					/>
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
						{/* 模型选择（ModelSelectorPopover） */}
						<button
							type="button"
							onClick={openModelSelect}
							className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)]"
							title="选择模型"
						>
							<span className="truncate max-w-[100px]">{currentModelLabel}</span>
						</button>
						{modelOpen && (
							<ModelSelectorPopover
								open={modelOpen}
								loading={modelsLoading}
								items={modelItems}
								selectedValue={model ? `${model.provider}/${model.modelId}` : undefined}
								query={modelQuery}
								activeIndex={modelActive}
								onSelect={selectModelItem}
								onQueryChange={setModelQuery}
								onHover={setModelActive}
								searchPlaceholder="搜索模型…"
								onClose={() => setModelOpen(false)}
								loadingText="加载模型中…"
								emptyText={
									modelsError
										? `加载失败：${modelsError}`
										: modelQuery
											? "无匹配模型"
											: "暂无可用模型，请先在设置中配置"
								}
							/>
						)}
						{/* 思考强度（ModelSelectorPopover） */}
						<button
							type="button"
							onClick={openThinkingSelect}
							className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)]"
							title="选择思考强度"
						>
							<span>思考：{thinkingLevel}</span>
						</button>
						{thinkingOpen && (
							<ModelSelectorPopover
								open={thinkingOpen}
								loading={false}
								items={!hasSession && !model ? [] : thinkingItems}
								selectedValue={thinkingLevel}
								query={thinkingQuery}
								activeIndex={thinkingActive}
								onSelect={selectThinkingItem}
								onQueryChange={setThinkingQuery}
								onHover={setThinkingActive}
								searchPlaceholder="搜索…"
								onClose={() => setThinkingOpen(false)}
								loadingText=""
								emptyText={
									!hasSession && !model
										? "请先选择模型，再设置思考强度"
										: "当前模型没有匹配的思考档位"
								}
							/>
						)}
						<button
							type="button"
							title="选择发送模式"
							className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)]"
							onClick={() => {
								setModelOpen(false);
								setThinkingOpen(false);
								setRunModeOpen(false);
								setMentionOpen(false);
								setCommandOpen(false);
								setSendModeQuery("");
								setSendModeActive(SEND_MODES.findIndex((item) => item.value === behavior));
								setSendModeOpen(!sendModeOpen);
							}}
						>
							<span>发送：{behavior === "followUp" ? "排队" : "直接"}</span>
						</button>
						<ModelSelectorPopover
							open={sendModeOpen}
							loading={false}
							items={sendModeItems}
							selectedValue={behavior}
							query={sendModeQuery}
							activeIndex={sendModeActive}
							onQueryChange={setSendModeQuery}
							onHover={setSendModeActive}
							onSelect={(value) => {
								if (value === "steer" || value === "followUp") setBehavior(value);
								setSendModeOpen(false);
								rootRef.current?.focus();
							}}
							onClose={() => setSendModeOpen(false)}
							searchPlaceholder="搜索发送模式…"
							emptyText="无匹配发送模式"
						/>
						<button
							type="button"
							onClick={openRunModeSelect}
							className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
							title="选择运行模式"
						>
							<ShieldCheckIcon className="size-3" />
							<span>{runModeLabel}</span>
						</button>
						{/* 引用文件 */}
						<button
							type="button"
							onClick={openFileMenu}
							disabled={!projectId}
							className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
							title="引用文件"
						>
							<FileIcon className="size-3" />
							<span>文件</span>
						</button>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						{(!isRunning || hasText) && (
							<button
								type="button"
								onClick={submit}
								disabled={!hasText || isSwitchingSession || isSubmitting}
								className="size-8 flex items-center justify-center rounded-full bg-[var(--button-face)] text-[var(--button-ink)] transition-all hover:opacity-85 active:scale-95 disabled:bg-[var(--bg-layer-02)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed"
								title={
									isSwitchingSession
										? "会话切换中，请稍候"
										: isRunning && behavior === "followUp"
											? "加入待发送队列（Enter）"
											: "发送（Enter）"
								}
							>
								<ArrowUpIcon className="size-4" strokeWidth={2.5} />
							</button>
						)}
						{isRunning && (
							<button
								type="button"
								onClick={onInterrupt}
								className="size-8 flex items-center justify-center rounded-full bg-[var(--button-face)] text-[var(--button-ink)] transition-all hover:bg-red-500 hover:scale-105 active:scale-95"
								title="中断当前轮（Esc）"
							>
								<SquareIcon className="size-3 fill-current" />
							</button>
						)}
					</div>
				</div>
			</div>
		</fieldset>
	);
}
