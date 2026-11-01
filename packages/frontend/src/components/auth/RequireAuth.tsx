/** 路由守卫：未登录 → /login；已登录访问 /login → /chat */

import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { me } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function RequireAuth({ children }: { children: React.ReactNode }) {
	const location = useLocation();
	const username = useAuthStore((s) => s.username);
	const checked = useAuthStore((s) => s.checked);
	const setUsername = useAuthStore((s) => s.setUsername);
	const setChecked = useAuthStore((s) => s.setChecked);

	useEffect(() => {
		if (!checked) {
			void me()
				.then((r) => setUsername(r.username))
				.catch(() => setUsername(null))
				.finally(() => setChecked(true));
		}
	}, [checked, setUsername, setChecked]);

	if (!checked)
		return (
			<div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
				加载中…
			</div>
		);
	if (!username) return <Navigate to="/login" replace state={{ from: location }} />;
	return <>{children}</>;
}

export function RequireAnon({ children }: { children: React.ReactNode }) {
	const username = useAuthStore((s) => s.username);
	const checked = useAuthStore((s) => s.checked);
	const setUsername = useAuthStore((s) => s.setUsername);
	const setChecked = useAuthStore((s) => s.setChecked);

	useEffect(() => {
		if (!checked) {
			void me()
				.then((r) => setUsername(r.username))
				.catch(() => setUsername(null))
				.finally(() => setChecked(true));
		}
	}, [checked, setUsername, setChecked]);

	if (!checked)
		return (
			<div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
				加载中…
			</div>
		);
	if (username) return <Navigate to="/chat" replace />;
	return <>{children}</>;
}
