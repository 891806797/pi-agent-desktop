import {
	AtSign,
	Braces,
	ChevronRight,
	Copy,
	FileCode,
	FileCog,
	FileImage,
	FileJson,
	FilePlus2,
	FileText,
	FileType,
	Folder,
	FolderInput,
	FolderPlus,
	Pencil,
	PenLine,
	Search,
	Trash2,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import * as fileApi from "@/lib/api";
import { useChatStore } from "@/stores/chat";
import type { FileSearchHit } from "./chat-input/types";

import {
	buildTree,
	CreateEntryDialog,
	DeleteEntryDialog,
	type FileEntry,
	MoveEntryDialog,
	RenameEntryDialog,
	UploadDialog,
} from "./file-tree-actions";

/** 右键菜单动作（open 仅文件；new-file/new-dir/upload 仅目录） */
type EntryAction =
	| "open"
	| "cite"
	| "copy"
	| "move"
	| "rename"
	| "delete"
	| "new-file"
	| "new-dir"
	| "upload";

type IconType = React.ComponentType<{ className?: string }>;

function getFileIconInfo(name: string): { Icon: IconType; color: string } {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "ts" || ext === "tsx") return { Icon: FileCode, color: "text-blue-500" };
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs")
		return { Icon: FileCode, color: "text-yellow-500" };
	if (ext === "json") return { Icon: FileJson, color: "text-green-500" };
	if (ext === "md" || ext === "mdx" || ext === "txt")
		return { Icon: FileText, color: "text-[var(--text-faint)]" };
	if (ext === "css" || ext === "scss" || ext === "less" || ext === "sass")
		return { Icon: Braces, color: "text-blue-400" };
	if (ext === "html" || ext === "htm" || ext === "xml" || ext === "svg")
		return { Icon: FileCode, color: "text-orange-500" };
	if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"].includes(ext))
		return { Icon: FileImage, color: "text-purple-500" };
	if (ext === "py") return { Icon: FileCode, color: "text-green-600" };
	if (ext === "go" || ext === "rs") return { Icon: FileCode, color: "text-orange-400" };
	if (ext === "java" || ext === "kt") return { Icon: FileCode, color: "text-red-500" };
	if (ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "env")
		return { Icon: FileCog, color: "text-rose-400" };
	if (ext === "sh" || ext === "bash" || ext === "zsh")
		return { Icon: FileCode, color: "text-green-400" };
	if (ext === "lock") return { Icon: FileCog, color: "text-[var(--text-faint)]" };
	return { Icon: FileType, color: "text-[var(--text-faint)]" };
}

function FileIcon({ name, isDir }: { name: string; isDir: boolean }): React.JSX.Element {
	if (isDir) return <Folder className="size-3.5 text-yellow-500/80 shrink-0" />;
	const { Icon, color } = getFileIconInfo(name);
	return <Icon className={`size-3.5 ${color} shrink-0`} />;
}

/** 单击文件 → 注入 composer @chip（PromptInput 监听 window 'composer:insert' 事件） */
function insertToComposer(path: string): void {
	window.dispatchEvent(new CustomEvent<string>("composer:insert", { detail: path }));
}

/** 文件树周期刷新间隔（agent 写文件等关键事件另有 'files:refresh' 即时触发，轮询兜底外部改动） */
const TREE_POLL_MS = 10_000;

/** 单击/双击消歧窗口：单击延迟 230ms 注入 @chip，双击在窗口内取消注入改开编辑器 */
const CLICK_DISAMBIGUATE_MS = 230;

/** 右键菜单内容（文件：打开…；目录：新建文件/新建目录…；两者共有引用/复制/移动/删除） */
function EntryMenuItems({
	entry,
	onAction,
}: {
	entry: FileEntry;
	onAction: (action: EntryAction, entry: FileEntry) => void;
}): React.JSX.Element {
	const item = "flex items-center gap-2";
	return (
		<ContextMenuContent>
			{entry.isDir ? (
				<>
					<ContextMenuItem className={item} onSelect={() => onAction("new-file", entry)}>
						<FilePlus2 /> 新建文件
					</ContextMenuItem>
					<ContextMenuItem className={item} onSelect={() => onAction("new-dir", entry)}>
						<FolderPlus /> 新建目录
					</ContextMenuItem>
					<ContextMenuItem className={item} onSelect={() => onAction("upload", entry)}>
						<Upload /> 上传文件
					</ContextMenuItem>
				</>
			) : (
				<ContextMenuItem className={item} onSelect={() => onAction("open", entry)}>
					<PenLine /> 打开
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem className={item} onSelect={() => onAction("cite", entry)}>
				<AtSign /> 引用
			</ContextMenuItem>
			<ContextMenuItem className={item} onSelect={() => onAction("copy", entry)}>
				<Copy /> 复制路径
			</ContextMenuItem>
			<ContextMenuItem className={item} onSelect={() => onAction("move", entry)}>
				<FolderInput /> 移动到…
			</ContextMenuItem>
			<ContextMenuItem className={item} onSelect={() => onAction("rename", entry)}>
				<Pencil /> 重命名
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				className={`${item} text-red-500 focus:text-red-500`}
				onSelect={() => onAction("delete", entry)}
			>
				<Trash2 /> 删除
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

function TreeNode({
	entry,
	depth,
	onSelect,
	onOpen,
	onAction,
}: {
	entry: FileEntry;
	depth: number;
	onSelect: (path: string) => void;
	onOpen: (path: string) => void;
	onAction: (action: EntryAction, entry: FileEntry) => void;
}): React.JSX.Element {
	const [expanded, setExpanded] = useState(depth < 1);
	// web 一次拉全量构建树（后端有界遍历），目录子节点已预置，无懒加载
	if (entry.isDir) {
		return (
			<div>
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<button
							type="button"
							aria-expanded={expanded}
							onClick={() => setExpanded((v) => !v)}
							className="flex items-center gap-1.5 w-full h-6 px-1.5 rounded-md text-left transition-colors duration-75 hover:bg-[var(--overlay-hover)] text-[12px] text-[var(--text-muted)]"
							style={{ paddingLeft: 8 + depth * 12 }}
						>
							<ChevronRight
								className={[
									"size-3 shrink-0 text-[var(--text-faint)] transition-transform",
									expanded && "rotate-90",
								].join(" ")}
							/>
							<FileIcon name={entry.name} isDir />
							<span className="truncate flex-1">{entry.name}</span>
						</button>
					</ContextMenuTrigger>
					<EntryMenuItems entry={entry} onAction={onAction} />
				</ContextMenu>
				{expanded && entry.children.length > 0 && (
					<div>
						{entry.children.map((c) => (
							<TreeNode
								key={c.path}
								entry={c}
								depth={depth + 1}
								onSelect={onSelect}
								onOpen={onOpen}
								onAction={onAction}
							/>
						))}
					</div>
				)}
				{expanded && entry.children.length === 0 && (
					<div
						className="text-[11px] text-[var(--text-faint)] py-1"
						style={{ paddingLeft: 8 + (depth + 1) * 12 + 16 }}
					>
						空目录
					</div>
				)}
			</div>
		);
	}
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<button
					type="button"
					draggable
					onClick={() => onSelect(entry.path)}
					onDoubleClick={() => onOpen(entry.path)}
					onDragStart={(e) => {
						e.dataTransfer.setData("text/plain", `file:${entry.path}`);
						e.dataTransfer.effectAllowed = "copyMove";
					}}
					className="flex items-center gap-1.5 w-full h-6 px-1.5 rounded-md text-left transition-colors duration-75 hover:bg-[var(--overlay-hover)] text-[12px] text-[var(--text-muted)]"
					style={{ paddingLeft: 8 + depth * 12 + 12 }}
					title={`单击引用 · 双击编辑 · 右键更多 ${entry.path}`}
				>
					<span className="w-3 shrink-0" />
					<FileIcon name={entry.name} isDir={false} />
					<span className="truncate flex-1">{entry.name}</span>
				</button>
			</ContextMenuTrigger>
			<EntryMenuItems entry={entry} onAction={onAction} />
		</ContextMenu>
	);
}

export function FileTree({
	projectId,
	onEdit,
}: {
	projectId: string | null;
	onEdit: (path: string) => void;
}): React.JSX.Element {
	const [tree, setTree] = useState<FileEntry[]>([]);
	const [treeError, setTreeError] = useState<string | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [treeLoading, setTreeLoading] = useState(true);
	const status = useChatStore((state) => state.status);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FileSearchHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);

	const searchSeq = useRef(0);
	const treeSeq = useRef(0);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (clickTimer.current !== null) clearTimeout(clickTimer.current);
		},
		[],
	);

	/** 有界文件树刷新；失败保留上次快照并提供重试 */
	const refreshTree = useCallback(async () => {
		if (!projectId) return;
		const seq = ++treeSeq.current;
		try {
			const { files } = await fileApi.listFiles(projectId);
			if (seq === treeSeq.current) {
				setTree(buildTree(files));
				setTreeError(null);
				setTruncated(files.length >= 2000);
			}
		} catch (error) {
			if (seq === treeSeq.current)
				setTreeError(error instanceof Error ? error.message : "文件加载失败");
		} finally {
			if (seq === treeSeq.current) setTreeLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		if (status === "idle" || status === "error") void refreshTree();
	}, [status, refreshTree]);

	// 初始加载 + 周期刷新（页面隐藏时跳过省请求）+ 'files:refresh' 事件即时刷新
	// 智能体状态变化与切回可见时也立即刷新。
	useEffect(() => {
		if (!projectId) {
			setTree([]);
			return;
		}
		void refreshTree();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") refreshTree();
		}, TREE_POLL_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") refreshTree();
		};
		const onFilesRefresh = () => refreshTree();
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("files:refresh", onFilesRefresh);
		return () => {
			treeSeq.current++;
			searchSeq.current++;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("files:refresh", onFilesRefresh);
		};
	}, [projectId, refreshTree]);

	/** 单击（延迟注入 @chip；after 在注入生效后回调，供搜索行清空输入） */
	const handleFileClick = (path: string, after?: () => void) => {
		if (clickTimer.current !== null) clearTimeout(clickTimer.current);
		clickTimer.current = setTimeout(() => {
			insertToComposer(path);
			after?.();
		}, CLICK_DISAMBIGUATE_MS);
	};

	/** 双击：取消挂起的单击注入，打开编辑弹框 */
	const handleFileOpen = (path: string) => {
		if (clickTimer.current !== null) {
			clearTimeout(clickTimer.current);
			clickTimer.current = null;
		}
		onEdit(path);
	};

	// ===== 文件管理（工具栏 + 右键菜单）=====
	/** 挂起的管理弹框；null = 关闭（条件渲染挂载，无需状态复位） */
	const [createDlg, setCreateDlg] = useState<{ kind: "file" | "dir"; baseDir: string } | null>(
		null,
	);
	const [moveDlg, setMoveDlg] = useState<{ path: string; isDir: boolean } | null>(null);
	const [renameDlg, setRenameDlg] = useState<string | null>(null);
	const [deleteDlg, setDeleteDlg] = useState<{ path: string; isDir: boolean } | null>(null);
	const [uploadList, setUploadList] = useState<File[] | null>(null);
	/** 本次上传的目标目录（目录右键上传 = 该目录；工具栏上传 = 项目根） */
	const [uploadDir, setUploadDir] = useState("");
	const uploadInputRef = useRef<HTMLInputElement>(null);

	/** 右键菜单/工具栏动作分发 */
	const handleEntryAction = (action: EntryAction, entry: FileEntry): void => {
		switch (action) {
			case "open":
				handleFileOpen(entry.path);
				break;
			case "cite":
				insertToComposer(entry.path);
				break;
			case "copy":
				void navigator.clipboard.writeText(entry.path).then(
					() => toast.success(`已复制 ${entry.path}`),
					() => toast.error("复制失败"),
				);
				break;
			case "move":
				setMoveDlg({ path: entry.path, isDir: entry.isDir });
				break;
			case "rename":
				setRenameDlg(entry.path);
				break;
			case "delete":
				setDeleteDlg({ path: entry.path, isDir: entry.isDir });
				break;
			case "new-file":
				setCreateDlg({ kind: "file", baseDir: entry.path });
				break;
			case "new-dir":
				setCreateDlg({ kind: "dir", baseDir: entry.path });
				break;
			case "upload":
				// 记住目标目录再触发文件选择器（onChange 时 state 已生效）
				setUploadDir(entry.path);
				uploadInputRef.current?.click();
				break;
		}
	};

	/** 创建成功：刷新树；新文件直接进入编辑 */
	const afterCreate = (kind: "file" | "dir", fullPath: string): void => {
		void refreshTree();
		if (kind === "file") onEdit(fullPath);
	};

	/** 文件选择器 → 打开上传弹框（value 复位以允许连续选同一批文件） */
	const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
		const list = Array.from(e.target.files ?? []);
		e.target.value = "";
		if (list.length > 0) setUploadList(list);
	};

	// 文件搜索（防抖 + 竞态守卫），同 PromptInput 的 @ 搜索数据源
	useEffect(() => {
		const q = query.trim();
		setSearching(false);
		setResults([]);
		if (!q || !projectId) return;
		const t = setTimeout(async () => {
			const seq = ++searchSeq.current;
			setSearching(true);
			try {
				const { files } = await fileApi.listFiles(projectId, q);
				const paths = files.filter((file) => !file.isDir).map((file) => file.path);
				if (seq === searchSeq.current) {
					setResults(
						paths.slice(0, 50).map((p) => {
							const name = p.split("/").pop() ?? p;
							return { path: p, name, relativePath: p, score: 0 };
						}),
					);
					setActiveIndex(0);
				}
			} catch {
				if (seq === searchSeq.current) setResults([]);
			} finally {
				if (seq === searchSeq.current) setSearching(false);
			}
		}, 80);
		return () => {
			searchSeq.current++;
			clearTimeout(t);
		};
	}, [query, projectId]);

	useEffect(() => {
		if (results.length) itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, results]);

	const handleSearchKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>): void => {
			if (results.length === 0) {
				if (e.key === "Escape") setQuery("");
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((i) => (i + 1) % results.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((i) => (i - 1 + results.length) % results.length);
			} else if (e.key === "Enter") {
				e.preventDefault();
				const hit = results[activeIndex];
				if (hit) {
					insertToComposer(hit.path);
					setQuery("");
					setResults([]);
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				setQuery("");
			}
		},
		[results, activeIndex],
	);

	const q = query.trim();
	const emptyTree = useMemo(() => tree.length === 0, [tree]);

	return (
		<div className="h-full flex flex-col">
			<div className="p-2 border-b border-[var(--border-muted)] shrink-0">
				<div className="flex items-center gap-1.5">
					<div className="flex flex-1 items-center gap-1.5 rounded-md bg-[var(--bg-layer-01)] px-2 py-1.5 min-w-0">
						<Search className="size-3.5 text-[var(--text-faint)] shrink-0" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleSearchKeyDown}
							aria-label="搜索文件"
							placeholder="搜索文件…（Enter 引用）"
							spellCheck={false}
							className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-base)] placeholder:text-[var(--text-faint)] outline-none"
						/>
						{searching && q && (
							<span className="size-3 rounded-full border border-[var(--text-faint)] border-t-transparent animate-spin shrink-0" />
						)}
					</div>
					<button
						type="button"
						aria-label="上传文件"
						title="上传文件"
						disabled={!projectId}
						onClick={() => {
							setUploadDir("");
							uploadInputRef.current?.click();
						}}
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)] disabled:pointer-events-none disabled:opacity-40"
					>
						<Upload className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="新建文件"
						title="新建文件"
						disabled={!projectId}
						onClick={() => setCreateDlg({ kind: "file", baseDir: "" })}
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)] disabled:pointer-events-none disabled:opacity-40"
					>
						<FilePlus2 className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="新建文件夹"
						title="新建文件夹"
						disabled={!projectId}
						onClick={() => setCreateDlg({ kind: "dir", baseDir: "" })}
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)] disabled:pointer-events-none disabled:opacity-40"
					>
						<FolderPlus className="size-3.5" />
					</button>
					<input ref={uploadInputRef} type="file" multiple hidden onChange={onPickFiles} />
				</div>
				{q && !searching && (
					<div className="mt-1 px-1 text-[11px] text-[var(--text-faint)]">
						{results.length > 0
							? `找到 ${results.length} 个文件 · ↑↓ 选择 · Enter 引用 · 双击编辑`
							: "无匹配文件"}
					</div>
				)}
			</div>
			{truncated && (
				<p className="px-3 text-xs text-[var(--text-muted)]">
					文件较多，仅显示前 2000 项；可搜索其他文件。
				</p>
			)}
			{treeError && (
				<div role="alert" className="px-3 py-2 text-xs text-destructive">
					{treeError}
					<button type="button" className="ml-2 underline" onClick={() => void refreshTree()}>
						重试
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto select-none">
				{!projectId ? (
					<div className="p-4 text-center text-[12px] text-[var(--text-faint)]">请先选择项目</div>
				) : q ? (
					<div className="py-1">
						{results.map((hit, i) => (
							<ContextMenu key={hit.path}>
								<ContextMenuTrigger asChild>
									<button
										type="button"
										draggable
										ref={(el) => {
											itemRefs.current[i] = el;
										}}
										onMouseEnter={() => setActiveIndex(i)}
										onClick={() =>
											handleFileClick(hit.path, () => {
												setQuery("");
												setResults([]);
											})
										}
										onDoubleClick={() => handleFileOpen(hit.path)}
										onDragStart={(e) => {
											e.dataTransfer.setData("text/plain", `file:${hit.path}`);
											e.dataTransfer.effectAllowed = "copyMove";
										}}
										className={[
											"flex items-center gap-1.5 w-full h-6 px-2 rounded-md text-left transition-colors text-[12px] text-[var(--text-muted)]",
											i === activeIndex
												? "bg-[var(--overlay-hover)]"
												: "hover:bg-[var(--overlay-hover)]",
										].join(" ")}
									>
										<FileIcon name={hit.name} isDir={false} />
										<span className="truncate shrink-0 max-w-[45%]">{hit.name}</span>
										<span className="text-[11px] text-[var(--text-faint)] truncate flex-1 text-right">
											{hit.relativePath}
										</span>
									</button>
								</ContextMenuTrigger>
								<EntryMenuItems
									entry={{ name: hit.name, path: hit.path, isDir: false, children: [] }}
									onAction={handleEntryAction}
								/>
							</ContextMenu>
						))}
					</div>
				) : emptyTree ? (
					<div className="p-4 text-center text-[12px] text-[var(--text-faint)]">
						{treeLoading ? "加载中…" : "目录为空"}
					</div>
				) : (
					<div className="py-1">
						{tree.map((entry) => (
							<TreeNode
								key={entry.path}
								entry={entry}
								depth={0}
								onSelect={handleFileClick}
								onOpen={handleFileOpen}
								onAction={handleEntryAction}
							/>
						))}
					</div>
				)}
			</div>

			{/* 文件管理弹框（条件渲染挂载；成功回调统一刷新树） */}
			{createDlg && projectId && (
				<CreateEntryDialog
					kind={createDlg.kind}
					baseDir={createDlg.baseDir}
					projectId={projectId}
					onCreated={afterCreate}
					onClose={() => setCreateDlg(null)}
				/>
			)}
			{moveDlg && projectId && (
				<MoveEntryDialog
					projectId={projectId}
					path={moveDlg.path}
					isDir={moveDlg.isDir}
					tree={tree}
					onDone={() => void refreshTree()}
					onClose={() => setMoveDlg(null)}
				/>
			)}
			{renameDlg && projectId && (
				<RenameEntryDialog
					projectId={projectId}
					path={renameDlg}
					onDone={() => void refreshTree()}
					onClose={() => setRenameDlg(null)}
				/>
			)}
			{deleteDlg && projectId && (
				<DeleteEntryDialog
					projectId={projectId}
					path={deleteDlg.path}
					isDir={deleteDlg.isDir}
					onDone={() => void refreshTree()}
					onClose={() => setDeleteDlg(null)}
				/>
			)}
			{uploadList && projectId && (
				<UploadDialog
					projectId={projectId}
					files={uploadList}
					initialDir={uploadDir}
					tree={tree}
					onDone={() => void refreshTree()}
					onClose={() => setUploadList(null)}
				/>
			)}
		</div>
	);
}
