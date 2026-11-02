import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as fileApi from "@/lib/api";

/**
 * 双击文件打开的在线编辑弹框：CodeMirror 语法高亮 + 编辑 + Ctrl+S 保存。
 * - 打开/切换文件时拉取内容；error 状态内联展示（不自动关闭，避免一闪而过）
 * - dirty（与服务端快照比对）；有未保存修改时首次关闭仅提示，3s 内再次关闭才生效
 * - 保存整体覆盖（后端限制：仅已存在文件、1MB 内、UTF-8 文本）
 */

/** 按扩展名选语言；未映射的类型回落纯文本（仍可编辑，只是无高亮） */
function languageFor(path: string) {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "ts") return javascript({ typescript: true });
	if (ext === "tsx") return javascript({ typescript: true, jsx: true });
	if (["js", "mjs", "cjs"].includes(ext)) return javascript();
	if (ext === "jsx") return javascript({ jsx: true });
	if (ext === "json") return json();
	if (["md", "mdx"].includes(ext)) return markdown();
	if (ext === "py") return python();
	if (["css", "scss", "less"].includes(ext)) return css();
	if (["html", "htm", "xml", "svg", "vue"].includes(ext)) return html();
	if (ext === "sql") return sql();
	if (["sh", "bash", "zsh"].includes(ext)) return StreamLanguage.define(shell);
	if (["yml", "yaml"].includes(ext)) return StreamLanguage.define(yaml);
	if (ext === "toml") return StreamLanguage.define(toml);
	return null;
}

/**
 * 编辑器主题与项目一致（暖米白，不用暗色）：chrome 全走全局 CSS 变量，
 * 语法色板取低饱和深色（对齐浅底的可读性，类 GitHub Light）。
 */
const editorTheme = EditorView.theme(
	{
		"&": { color: "var(--text-base)", backgroundColor: "transparent" },
		".cm-scroller": { fontFamily: "inherit", lineHeight: "1.65" },
		".cm-content": { caretColor: "var(--text-base)" },
		".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--text-muted)" },
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
			backgroundColor: "var(--overlay-hover)",
		},
		".cm-activeLine": { backgroundColor: "var(--overlay-hover)" },
		".cm-gutters": {
			backgroundColor: "transparent",
			color: "var(--text-faint)",
			border: "none",
		},
		".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
		".cm-matchingBracket": {
			backgroundColor: "var(--overlay-hover)",
			outline: "1px solid var(--border-base)",
		},
	},
	{ dark: false },
);

const editorHighlight = HighlightStyle.define([
	{ tag: [t.heading], fontWeight: "700", color: "#6d28d9" },
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#b3352c" },
	{ tag: [t.string, t.special(t.string), t.link], color: "#0a5a9a" },
	{ tag: [t.url], color: "#0a5a9a", textDecoration: "underline" },
	{ tag: [t.number, t.bool, t.null], color: "#9a3412" },
	{
		tag: [t.comment, t.lineComment, t.blockComment],
		color: "var(--text-faint)",
		fontStyle: "italic",
	},
	{ tag: [t.typeName, t.className, t.namespace], color: "#0f766e" },
	{ tag: [t.tagName], color: "#116329" },
	{ tag: [t.attributeName, t.propertyName], color: "#0f766e" },
	{ tag: [t.function(t.variableName)], color: "#7c3aed" },
	{ tag: [t.emphasis], fontStyle: "italic" },
	{ tag: [t.strong], fontWeight: "700" },
	{ tag: [t.meta, t.processingInstruction], color: "var(--text-faint)" },
]);

const editorStyle = [editorTheme, syntaxHighlighting(editorHighlight)];

interface FileEditorDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string | null;
	path: string | null;
}

export function FileEditorDialog({
	open,
	onOpenChange,
	projectId,
	path,
}: FileEditorDialogProps): React.JSX.Element {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 服务端内容快照（脏检测基准）；null = 未加载成功 */
	const [loaded, setLoaded] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [revision, setRevision] = useState("");
	const [saving, setSaving] = useState(false);
	const seq = useRef(0);
	/** 二次关闭防误触：dirty 时首次关闭仅提示，3s 窗口内再次关闭才放弃 */
	const closeArmed = useRef(false);
	const saveRef = useRef<() => void>(() => {});

	// 打开/切换文件 → 拉取内容；关闭 → 整体复位
	useEffect(() => {
		const cur = ++seq.current;
		closeArmed.current = false;
		if (!open || !projectId || !path) {
			setLoading(false);
			setError(null);
			setLoaded(null);
			setDraft("");
			return;
		}
		setLoaded(null);
		setDraft("");
		setLoading(true);
		setError(null);
		fileApi
			.getFileContent(projectId, path)
			.then((r) => {
				if (seq.current !== cur) return;
				setLoaded(r.content);
				setDraft(r.content);
				setRevision(r.revision);
			})
			.catch((e: unknown) => {
				if (seq.current !== cur) return;
				setError(e instanceof Error ? e.message : "读取失败");
			})
			.finally(() => {
				if (seq.current === cur) setLoading(false);
			});
		return () => {
			seq.current++;
		};
	}, [open, projectId, path]);

	const dirty = loaded !== null && draft !== loaded;
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty]);

	const save = useCallback(async () => {
		if (!projectId || !path || loaded === null || !dirty || saving) return;
		setSaving(true);
		try {
			const current = seq.current;
			const result = await fileApi.saveFileContent(projectId, path, draft, revision);
			if (current !== seq.current) return;
			setRevision(result.revision);
			setLoaded(draft);
			closeArmed.current = false;
			toast.success(`已保存 ${path}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "保存失败");
		} finally {
			setSaving(false);
		}
	}, [projectId, path, loaded, dirty, draft, saving, revision]);
	saveRef.current = save;

	// 有未保存修改时拦截关闭：首次提示，3s 内再关一次才放弃（防 Esc/X 误触丢工作）
	const requestClose = useCallback(() => {
		if (saving) return;
		if (dirty && !closeArmed.current) {
			closeArmed.current = true;
			toast.warning("有未保存的修改，再次关闭将放弃", { duration: 3000 });
			setTimeout(() => {
				closeArmed.current = false;
			}, 3000);
			return;
		}
		onOpenChange(false);
	}, [dirty, saving, onOpenChange]);

	// Ctrl/Cmd+S 保存（keymap 闭包经 saveRef 间接引用，extensions 保持引用稳定）
	const extensions = useMemo(() => {
		const lang = path ? languageFor(path) : null;
		const saveKey = Prec.high(
			keymap.of([
				{
					key: "Mod-s",
					run: () => {
						saveRef.current();
						return true;
					},
				},
			]),
		);
		return lang ? [saveKey, lang] : [saveKey];
	}, [path]);

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
			<DialogContent
				aria-describedby={undefined}
				className="flex h-[90vh] w-[90vw] max-w-none flex-col gap-0 overflow-hidden p-0"
			>
				<DialogHeader className="shrink-0 border-b border-[var(--border-muted)] px-4 py-3">
					<DialogTitle className="font-mono text-[13px] break-all">{path ?? ""}</DialogTitle>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-hidden">
					{loading ? (
						<div className="flex h-full items-center justify-center text-[13px] text-[var(--text-faint)]">
							加载中…
						</div>
					) : error ? (
						<div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-[var(--text-faint)]">
							{error}
						</div>
					) : (
						<CodeMirror
							value={draft}
							height="100%"
							theme="none"
							extensions={[...extensions, editorStyle]}
							onChange={setDraft}
							style={{ height: "100%", fontSize: 13 }}
						/>
					)}
				</div>
				<div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-muted)] px-4 py-2.5">
					<div className="flex min-w-0 items-center gap-3 text-[12px] text-[var(--text-faint)]">
						{dirty ? (
							<span className="text-amber-400">● 未保存</span>
						) : (
							<span className="truncate">{loaded !== null ? `${loaded.length} 字符` : ""}</span>
						)}
						<span className="shrink-0">Ctrl+S 保存</span>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="ghost" size="sm" onClick={requestClose}>
							关闭
						</Button>
						<Button size="sm" disabled={!dirty || saving} onClick={() => save()}>
							{saving ? "保存中…" : "保存"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
