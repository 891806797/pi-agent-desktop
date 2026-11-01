import { LogIn } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function LoginPage() {
	const navigate = useNavigate();
	const setUsername = useAuthStore((s) => s.setUsername);
	const setChecked = useAuthStore((s) => s.setChecked);
	const [username, setUsernameField] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const r = await login(username, password);
			setUsername(r.username);
			setChecked(true);
			navigate("/chat");
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<Card className="w-full max-w-sm p-6 shadow-sm">
				<div className="mb-5 flex items-center gap-2">
					<div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
						<LogIn className="size-4" />
					</div>
					<div>
						<h1 className="text-base font-semibold">pi-agent</h1>
						<p className="text-[11px] text-muted-foreground">登录以开始</p>
					</div>
				</div>
				<form onSubmit={submit} className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="u" className="text-xs">
							用户名
						</Label>
						<Input
							id="u"
							value={username}
							onChange={(e) => setUsernameField(e.target.value)}
							autoComplete="username"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="p" className="text-xs">
							密码
						</Label>
						<Input
							id="p"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="current-password"
						/>
					</div>
					{error && <p className="text-xs text-destructive">{error}</p>}
					<Button type="submit" disabled={busy || !username || !password} className="w-full">
						{busy ? "登录中…" : "登录"}
					</Button>
				</form>
			</Card>
		</div>
	);
}
