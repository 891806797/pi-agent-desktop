import { ModelSettingsInput } from "@pi-agent/common";
import { ArrowLeft, Check, Loader2, Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ZodError } from "zod";
import { ProviderEditor } from "@/components/settings/ProviderEditor";
import { Button } from "@/components/ui/button";
import { getSettingsModels, putSettingsModels } from "@/lib/api";
import {
	buildModelSettings,
	newProvider,
	type ProviderDraft,
	providerDrafts,
} from "@/lib/model-settings";

export function SettingsPage() {
	const navigate = useNavigate();
	const [original, setOriginal] = useState<ModelSettingsInput | null>(null);
	const [providers, setProviders] = useState<ProviderDraft[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [reload, setReload] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户重试读取配置的显式触发器。
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		void getSettingsModels()
			.then((response) => {
				if (cancelled) return;
				const config = ModelSettingsInput.parse(response.models);
				setOriginal(config);
				setProviders(providerDrafts(config));
			})
			.catch((error) => {
				if (!cancelled) setError(error instanceof Error ? error.message : "模型配置加载失败");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [reload]);
	const change = (next: ProviderDraft[]) => {
		setProviders(next);
		setDirty(true);
		setSaved(false);
		setError(null);
	};

	async function save() {
		if (!original || saving) return;
		setError(null);
		setSaved(false);
		setSaving(true);
		try {
			const parsed = buildModelSettings(original, providers);
			await putSettingsModels(parsed);
			setOriginal(parsed);
			setSaved(true);
			setDirty(false);
		} catch (e) {
			setError(
				e instanceof ZodError
					? e.issues.map((issue) => `${issue.path.join(" · ")}：${issue.message}`).join("\n")
					: e instanceof Error
						? e.message
						: "配置保存失败",
			);
		} finally {
			setSaving(false);
		}
	}

	return (
		<main className="min-h-dvh bg-[var(--bg-base)] text-foreground">
			<form
				className="mx-auto max-w-4xl px-4 pb-12 pt-6 sm:px-8 sm:pt-10"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<button
					type="button"
					onClick={() => navigate(-1)}
					className="mb-7 inline-flex items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
				>
					<ArrowLeft aria-hidden className="size-3.5" />
					返回聊天
				</button>
				<header className="mb-7 flex flex-wrap items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">模型配置</h1>
						<p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
							配置服务商连接与模型能力，聊天时即可直接选择。
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							{providers.length} 个 Provider ·{" "}
							{providers.reduce((count, provider) => count + provider.models.length, 0)} 个模型
							{dirty ? " · 有未保存的修改" : ""}
						</p>
					</div>
					<Button type="submit" disabled={loading || !original || saving} className="shrink-0">
						{saving ? (
							<Loader2 aria-hidden className="size-4 animate-spin" />
						) : saved ? (
							<Check aria-hidden className="size-4" />
						) : (
							<Save aria-hidden className="size-4" />
						)}
						{saving ? "保存中…" : "保存配置"}
					</Button>
				</header>
				{error && (
					<div
						role="alert"
						className="mb-5 whitespace-pre-wrap break-words rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
					>
						{error}
						{!original && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="ml-3"
								onClick={() => setReload((value) => value + 1)}
							>
								重新加载
							</Button>
						)}
					</div>
				)}
				{saved && (
					<p
						role="status"
						className="mb-5 flex items-center gap-2 text-sm text-[var(--text-muted)]"
					>
						<Check aria-hidden className="size-4" />
						配置已保存，返回聊天即可使用
					</p>
				)}
				{loading ? (
					<p role="status" className="py-16 text-center text-sm text-muted-foreground">
						正在读取模型配置…
					</p>
				) : (
					original && (
						<fieldset disabled={saving} className="min-w-0 space-y-5 disabled:opacity-70">
							{providers.map((provider, index) => (
								<ProviderEditor
									key={provider.key}
									draft={provider}
									index={index}
									onChange={(next) =>
										change(providers.map((item) => (item.key === provider.key ? next : item)))
									}
									onRemove={() => change(providers.filter((item) => item.key !== provider.key))}
								/>
							))}
							<Button
								type="button"
								variant="outline"
								className="h-16 w-full rounded-2xl border-dashed bg-transparent text-muted-foreground hover:border-primary/50 hover:text-primary"
								onClick={() => change([...providers, newProvider()])}
							>
								<Plus aria-hidden className="size-4" />
								添加 Provider
							</Button>
							<p className="text-center text-xs leading-relaxed text-muted-foreground">
								模型名称与 ID 保持一致。默认思考强度用于新会话及切换模型，已有会话保留各自选择。
							</p>
						</fieldset>
					)
				)}
			</form>
		</main>
	);
}
