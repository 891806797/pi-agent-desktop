/** DirectoryPicker —— 文件夹选择器（照抄 csm-ai/claude-agent-web，样式 + 结构原样） */

import { ArrowUp, Folder, HardDrive, Home } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { listDirs } from "@/lib/api";

interface DirsResult {
	current: string;
	entries: Array<{ name: string; path: string }>;
	drives: string[];
}

export function DirectoryPicker({
	open,
	onClose,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	onConfirm: (path: string) => void;
}) {
	const [data, setData] = useState<DirsResult>({ current: "", entries: [], drives: [] });
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	async function go(p: string) {
		setLoading(true);
		setError("");
		try {
			setData(await listDirs(p || undefined));
		} catch (e) {
			setError(e instanceof Error ? e.message : "读取目录失败");
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		if (!open) return;
		// 首屏加载根目录（不通过 go，避免把 go 列入依赖）
		setLoading(true);
		setError("");
		void listDirs()
			.then((r) => setData(r))
			.catch((e) => setError(e instanceof Error ? e.message : "读取目录失败"))
			.finally(() => setLoading(false));
	}, [open]);

	const parent = data.current.replace(/[^/\\]+[/\\]?$/, "");
	const atRoot = parent === "" || parent === data.current;

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>选择项目根目录</DialogTitle>
					<DialogDescription>
						逐级进入目录，「使用当前目录」确定；项目路径须存在于服务器磁盘。
					</DialogDescription>
				</DialogHeader>

				{/* 当前路径 + 返回上级 */}
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => void go(parent)}
						disabled={atRoot || loading}
						aria-label="返回上级目录"
					>
						<ArrowUp className="size-4" />
					</Button>
					<p className="min-w-0 flex-1 truncate rounded-md bg-[var(--bg-layer-01)] px-3 py-1.5 font-mono text-[12px] text-[var(--text-muted)]">
						{data.current || "…"}
					</p>
				</div>

				{/* 快捷：主目录 + 盘符 */}
				{data.drives.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						<Button variant="outline" size="sm" onClick={() => void go("")}>
							<Home className="size-3.5" /> 主目录
						</Button>
						{data.drives.map((d) => (
							<Button key={d} variant="outline" size="sm" onClick={() => void go(d)}>
								<HardDrive className="size-3.5" aria-hidden />
								{d}
							</Button>
						))}
					</div>
				)}

				<div
					className="max-h-[300px] min-h-[160px] overflow-y-auto rounded-lg border border-[var(--border-muted)]"
					aria-busy={loading}
				>
					{data.entries.length === 0 && !loading && (
						<p className="px-4 py-8 text-center text-[13px] text-[var(--text-muted)]">
							此目录下没有子文件夹
						</p>
					)}
					{data.entries.map((e) => (
						<button
							key={e.path}
							type="button"
							onClick={() => void go(e.path)}
							className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--overlay-hover)]"
						>
							<Folder className="size-4 shrink-0 text-primary/70" aria-hidden />
							<span className="truncate">{e.name}</span>
						</button>
					))}
				</div>

				{error && (
					<p className="text-[12px] text-destructive" role="alert">
						{error}
					</p>
				)}

				<DialogFooter>
					<Button
						onClick={() => {
							onConfirm(data.current);
							onClose();
						}}
						disabled={loading || !data.current}
					>
						使用当前目录
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
