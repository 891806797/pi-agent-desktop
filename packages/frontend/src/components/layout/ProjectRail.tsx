/**
 * ProjectRail —— 64px 项目图标栏（复刻 opencode sidebar-rail）。
 * 项目 tile：size-10 圆角方块（选中 border-2，active bg），底部设置/退出。
 */

import type { WorkspaceInfo } from "@pi-agent/common";
import { HelpCircle, LogOut, Plus, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { logout } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/** 按项目名 hash 选暖色调背景，首字符头像便于区分 */
const AVATAR_COLORS = [
	{ bg: "#b4632a", fg: "#fff" }, // 赭
	{ bg: "#5a7a52", fg: "#fff" }, // 橄榄
	{ bg: "#6b5b8a", fg: "#fff" }, // 紫
	{ bg: "#8a5a4a", fg: "#fff" }, // 棕
	{ bg: "#4a6a7a", fg: "#fff" }, // 青
	{ bg: "#a67c3a", fg: "#fff" }, // 金
	{ bg: "#7a4a5a", fg: "#fff" }, // 玫
	{ bg: "#3a6a6a", fg: "#fff" }, // 深青
];
function avatarColor(name: string): { bg: string; fg: string } {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
function initial(name: string): string {
	const t = name.trim();
	return t ? t[0]!.toUpperCase() : "?";
}

function ProjectTile({
	project,
	active,
	onClick,
}: {
	project: WorkspaceInfo;
	active: boolean;
	onClick: () => void;
}) {
	const c = avatarColor(project.name);
	return (
		<button
			type="button"
			title={`${project.name}\n${project.path}`}
			onClick={onClick}
			className={`flex size-10 items-center justify-center overflow-hidden rounded-lg border p-0 transition-colors ${
				active
					? "border-2 border-[var(--text-base)]"
					: "border border-transparent hover:border-[var(--border-muted)] hover:bg-[var(--overlay-hover)]"
			}`}
		>
			<span
				className="flex size-full select-none items-center justify-center text-[16px] font-semibold"
				style={{ backgroundColor: c.bg, color: c.fg }}
			>
				{initial(project.name)}
			</span>
		</button>
	);
}

export function ProjectRail({
	projects,
	activeEncoded,
	onSelect,
	onAddProject,
}: {
	projects: WorkspaceInfo[];
	activeEncoded: string | null;
	onSelect: (encoded: string) => void;
	onAddProject: () => void;
}) {
	const navigate = useNavigate();
	const setUsername = useAuthStore((s) => s.setUsername);

	const doLogout = async () => {
		await logout();
		setUsername(null);
		navigate("/login", { replace: true });
	};

	return (
		<div className="flex h-full w-16 shrink-0 flex-col items-center overflow-hidden bg-[var(--bg-deep)]">
			<div className="flex h-full w-full flex-1 flex-col items-center gap-3 overflow-y-auto px-3 py-3">
				{projects.map((p) => (
					<ProjectTile
						key={p.encoded}
						project={p}
						active={p.encoded === activeEncoded}
						onClick={() => onSelect(p.encoded)}
					/>
				))}
				<button
					type="button"
					title="添加项目"
					onClick={onAddProject}
					className="flex size-10 items-center justify-center rounded-lg border border-dashed border-[var(--border-muted)] text-[var(--text-muted)] transition-colors hover:border-[var(--text-base)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)]"
				>
					<Plus className="size-5" />
				</button>
			</div>
			<div className="flex w-full shrink-0 flex-col items-center gap-2 pb-6 pt-3">
				<button
					type="button"
					title="设置"
					onClick={() => navigate("/settings")}
					className="flex size-8 items-center justify-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)]"
				>
					<Settings className="size-4" />
				</button>
				<button
					type="button"
					title="帮助"
					className="flex size-8 items-center justify-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)]"
				>
					<HelpCircle className="size-4" />
				</button>
				<button
					type="button"
					title="退出登录"
					onClick={() => void doLogout()}
					className="flex size-8 items-center justify-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--overlay-hover)] hover:text-[var(--text-base)]"
				>
					<LogOut className="size-4" />
				</button>
			</div>
		</div>
	);
}
