import type { FileItem } from "@pi-agent/common";
import { FilePath } from "@pi-agent/common/dto/requests";
import { ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import * as fileApi from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 文件树操作弹框族（创建/移动/删除/上传）——右键菜单与工具栏的承接 UI。
 * 各弹框自管 API 调用与 loading/错误 toast；成功后经 onDone 通知 FileTree
 * 刷新树。弹框由父组件条件渲染挂载（无需 open prop 与状态复位）。
 */

/** 与后端 /files 协议对齐的树节点（buildTree 由扁平相对路径构建） */
export interface FileEntry extends FileItem {
	children: FileEntry[];
}

/** 从当前公共文件契约构建树，保留空目录并按目录优先排序。 */
export function buildTree(files: FileItem[]): FileEntry[] {
	const root: FileEntry[] = [];
	for (const { path, isDir: isDirPath } of files) {
		const parts = path.split("/");
		let level = root;
		let acc = "";
		parts.forEach((part, i) => {
			acc = acc ? `${acc}/${part}` : part;
			const isDir = i < parts.length - 1 || isDirPath;
			let node = level.find((n) => n.name === part);
			if (!node) {
				node = { name: part, path: acc, isDir, children: [] };
				level.push(node);
			} else if (isDir) {
				// 防御：先作为文件出现后又被标记为目录，升级为目录
				node.isDir = true;
			}
			level = node.children;
		});
	}
	const sort = (nodes: FileEntry[]) => {
		nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
		nodes.forEach((n) => {
			sort(n.children);
		});
	};
	sort(root);
	return root;
}

/** 浏览器 File → 纯 base64（readAsDataURL 剥 data 前缀，UTF-8 安全） */
export function fileToBase64(f: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
		r.onerror = () => reject(r.error ?? new Error("读取文件失败"));
		r.readAsDataURL(f);
	});
}

// ===== 目录选择器（移动/上传弹框共用） =====

/**
 * 目录树点选 + 输入框混合：点选回填输入框，也可直接手输任意相对目录
 * （后端在目标目录不存在时自动创建）。excludeUnder 用于目录移动时禁选自身及子目录。
 */
function DirPicker({
	tree,
	value,
	onChange,
	excludeUnder,
}: {
	tree: FileEntry[];
	value: string;
	onChange: (dir: string) => void;
	excludeUnder?: string;
}): React.JSX.Element {
	const under = (dir: string): boolean =>
		dir === excludeUnder || (!!excludeUnder && dir.startsWith(`${excludeUnder}/`));
	return (
		<div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border-muted)] p-1">
			<DirRow label="项目根" path="" depth={0} value={value} onChange={onChange} disabled={false} />
			{tree
				.filter((e) => e.isDir)
				.map((e) => (
					<DirNode
						key={e.path}
						entry={e}
						depth={1}
						value={value}
						onChange={onChange}
						under={under}
					/>
				))}
		</div>
	);
}

function DirNode({
	entry,
	depth,
	value,
	onChange,
	under,
}: {
	entry: FileEntry;
	depth: number;
	value: string;
	onChange: (dir: string) => void;
	under: (dir: string) => boolean;
}): React.JSX.Element {
	const [open, setOpen] = useState(depth < 2);
	const dirs = entry.children.filter((c) => c.isDir);
	return (
		<div>
			<DirRow
				label={entry.name}
				path={entry.path}
				depth={depth}
				value={value}
				onChange={onChange}
				disabled={under(entry.path)}
				expandable={dirs.length > 0}
				expanded={open}
				onToggle={() => setOpen((v) => !v)}
			/>
			{open &&
				dirs.map((c) => (
					<DirNode
						key={c.path}
						entry={c}
						depth={depth + 1}
						value={value}
						onChange={onChange}
						under={under}
					/>
				))}
		</div>
	);
}

function DirRow({
	label,
	path,
	depth,
	value,
	onChange,
	disabled,
	expandable,
	expanded,
	onToggle,
}: {
	label: string;
	path: string;
	depth: number;
	value: string;
	onChange: (dir: string) => void;
	disabled: boolean;
	expandable?: boolean;
	expanded?: boolean;
	onToggle?: () => void;
}): React.JSX.Element {
	return (
		<div
			className={cn(
				"flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors",
				value === path
					? "bg-[var(--overlay-hover)] text-[var(--text-base)]"
					: "text-[var(--text-muted)] hover:bg-[var(--overlay-hover)]",
				disabled && "pointer-events-none opacity-40",
			)}
			style={{ paddingLeft: 6 + depth * 14 }}
		>
			{expandable ? (
				<button
					type="button"
					aria-label={`展开或收起 ${label}`}
					aria-expanded={expanded}
					disabled={disabled}
					onClick={() => onToggle?.()}
				>
					<ChevronRight
						className={cn(
							"size-3 shrink-0 text-[var(--text-faint)] transition-transform",
							expanded && "rotate-90",
						)}
					/>
				</button>
			) : (
				<span className="w-3 shrink-0" />
			)}
			<Folder className="size-3.5 shrink-0 text-yellow-500/80" />
			<button
				type="button"
				disabled={disabled}
				aria-pressed={value === path}
				className="min-w-0 flex-1 truncate text-left"
				onClick={() => onChange(path)}
			>
				{label}
			</button>
		</div>
	);
}

// ===== 新建文件/目录 =====

export function CreateEntryDialog({
	kind,
	baseDir,
	projectId,
	onCreated,
	onClose,
}: {
	kind: "file" | "dir";
	baseDir: string;
	projectId: string;
	onCreated: (kind: "file" | "dir", path: string) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (): Promise<void> => {
		const rel = name.trim();
		if (!rel || busy) return;
		const fullPath = baseDir ? `${baseDir}/${rel}` : rel;
		setBusy(true);
		try {
			if (kind === "file") await fileApi.createFile(projectId, fullPath);
			else await fileApi.createDir(projectId, fullPath);
			toast.success(`已创建 ${fullPath}`);
			onCreated(kind, fullPath);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "创建失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{kind === "file" ? "新建文件" : "新建目录"}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="text-[12px] text-[var(--text-faint)]">
						位于 {baseDir ? `${baseDir}/` : "项目根"} 下；输入多级路径将自动创建中间目录。
					</div>
					<Input
						value={name}
						autoFocus
						spellCheck={false}
						aria-label="新建路径"
						placeholder={kind === "file" ? "src/utils/format.ts" : "docs/images"}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && submit()}
					/>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
						取消
					</Button>
					<Button size="sm" disabled={!name.trim() || busy} onClick={() => submit()}>
						{busy ? "创建中…" : "创建"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ===== 重命名（复用 move 接口：同父目录 rename） =====

/** 新名称合法性（与后端文件名校验对齐：禁分隔符/非法字符/控制符/尾点尾空格及 . ..） */
function isValidEntryName(n: string): boolean {
	return !n.includes("/") && FilePath.safeParse(n).success;
}

export function RenameEntryDialog({
	projectId,
	path,
	onDone,
	onClose,
}: {
	projectId: string;
	path: string;
	onDone: (to: string) => void;
	onClose: () => void;
}): React.JSX.Element {
	const oldName = path.split("/").pop() ?? path;
	const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	const [name, setName] = useState(oldName);
	const [busy, setBusy] = useState(false);
	const trimmed = name.trim();
	const to = parent ? `${parent}/${trimmed}` : trimmed;
	const valid = isValidEntryName(trimmed) && to !== path;

	const submit = async (): Promise<void> => {
		if (!valid || busy) return;
		setBusy(true);
		try {
			await fileApi.moveEntry(projectId, path, to);
			toast.success(`已重命名为 ${trimmed}`);
			onDone(to);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "重命名失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="font-mono text-[13px] break-all">重命名 {path}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<Input
						value={name}
						autoFocus
						spellCheck={false}
						aria-label="新名称"
						placeholder={oldName}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && submit()}
					/>
					<div className="text-[12px] text-[var(--text-faint)] break-all">
						将重命名为 <span className="font-mono">{to}</span>
						{trimmed !== oldName && !valid && "（名称不合法或与当前相同）"}
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
						取消
					</Button>
					<Button size="sm" disabled={!valid || busy} onClick={() => submit()}>
						{busy ? "重命名中…" : "重命名"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ===== 移动（目录树点选 + 可输入新目录） =====

export function MoveEntryDialog({
	projectId,
	path,
	isDir,
	tree,
	onDone,
	onClose,
}: {
	projectId: string;
	path: string;
	isDir: boolean;
	tree: FileEntry[];
	onDone: (to: string) => void;
	onClose: () => void;
}): React.JSX.Element {
	const name = path.split("/").pop() ?? path;
	const [dir, setDir] = useState(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const [busy, setBusy] = useState(false);
	const to = dir ? `${dir}/${name}` : name;

	const submit = async (): Promise<void> => {
		if (busy || to === path) return;
		setBusy(true);
		try {
			await fileApi.moveEntry(projectId, path, to);
			toast.success(`已移动到 ${to}`);
			onDone(to);
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "移动失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="font-mono text-[13px] break-all">移动 {path}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<Input
						value={dir}
						spellCheck={false}
						aria-label="目标目录"
						placeholder="目标目录（空 = 项目根；不存在时自动创建）"
						onChange={(e) => setDir(e.target.value.replace(/\\/g, "").trimStart())}
					/>
					<DirPicker
						tree={tree}
						value={dir}
						onChange={setDir}
						excludeUnder={isDir ? path : undefined}
					/>
					<div className="text-[12px] text-[var(--text-faint)] break-all">
						将移动到 <span className="font-mono">{to}</span>
						{to === path && "（与当前位置相同）"}
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
						取消
					</Button>
					<Button size="sm" disabled={busy || to === path} onClick={() => submit()}>
						{busy ? "移动中…" : "移动"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ===== 删除确认 =====

export function DeleteEntryDialog({
	projectId,
	path,
	isDir,
	onDone,
	onClose,
}: {
	projectId: string;
	path: string;
	isDir: boolean;
	onDone: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const [busy, setBusy] = useState(false);

	const submit = async (): Promise<void> => {
		if (busy) return;
		setBusy(true);
		try {
			await fileApi.deleteEntry(projectId, path);
			toast.success(`已删除 ${path}`);
			onDone();
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "删除失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>确认删除</DialogTitle>
				</DialogHeader>
				<div className="space-y-2 text-[13px]">
					<div className="font-mono break-all text-[var(--text-base)]">{path}</div>
					{isDir && (
						<div className="text-red-500">将递归删除该目录及其全部内容，操作不可恢复。</div>
					)}
					{!isDir && <div className="text-[var(--text-faint)]">删除后不可恢复。</div>}
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
						取消
					</Button>
					<Button variant="destructive" size="sm" disabled={busy} onClick={() => submit()}>
						{busy ? "删除中…" : "删除"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ===== 上传（选目标目录 + 预检） =====

/** 单文件上限（与服务端 MAX_EDITABLE_FILE_BYTES 对齐） */
const MAX_UPLOAD_BYTES = 1_048_576;

export function UploadDialog({
	projectId,
	files,
	tree,
	initialDir = "",
	onDone,
	onClose,
}: {
	projectId: string;
	files: File[];
	tree: FileEntry[];
	/** 打开弹框时预选的目标目录（目录右键上传时传入该目录） */
	initialDir?: string;
	onDone: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const [dir, setDir] = useState(initialDir);
	const [busy, setBusy] = useState(false);
	const okFiles = files.filter((f) => f.size <= MAX_UPLOAD_BYTES).slice(0, 10);
	const skipped = files.length - okFiles.length;

	const submit = async (): Promise<void> => {
		if (busy || okFiles.length === 0) return;
		setBusy(true);
		try {
			const payload = await Promise.all(
				okFiles.map(async (f) => ({ name: f.name, contentBase64: await fileToBase64(f) })),
			);
			const r = await fileApi.uploadFiles(projectId, dir.replace(/\\/g, "").trim(), payload);
			toast.success(`已上传 ${r.saved.length} 个文件到 ${dir || "项目根"}`);
			onDone();
			onClose();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "上传失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>上传 {files.length} 个文件</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-[var(--border-muted)] p-2 text-[12px]">
						{files.map((f) => (
							<div key={`${f.name}-${f.size}`} className="flex justify-between gap-2">
								<span className="truncate font-mono">{f.name}</span>
								<span
									className={cn(
										"shrink-0",
										f.size > MAX_UPLOAD_BYTES ? "text-red-500" : "text-[var(--text-faint)]",
									)}
								>
									{(f.size / 1024).toFixed(1)} KB
									{f.size > MAX_UPLOAD_BYTES ? " · 超过 1MB 将跳过" : ""}
								</span>
							</div>
						))}
					</div>
					{skipped > 0 && (
						<div className="text-[12px] text-red-500">
							{skipped} 个文件超过 1MB 或超出批量上限 10 个，将被跳过。
						</div>
					)}
					<DirPicker tree={tree} value={dir} onChange={setDir} />
					<div className="text-[12px] text-[var(--text-faint)]">
						上传到 <span className="font-mono">{dir || "项目根"}</span>
						（目录不存在时自动创建；同名文件将被整体拒绝）
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
						取消
					</Button>
					<Button size="sm" disabled={busy || okFiles.length === 0} onClick={() => submit()}>
						{busy ? "上传中…" : "上传"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
