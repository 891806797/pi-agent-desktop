import {
	type ModelConfig,
	modelThinkingLevels,
	THINKING_LABELS,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "@pi-agent/common";
import { Check, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { type ModelDraft, newModel, type ProviderDraft } from "@/lib/model-settings";

const APIs = [
	["openai-completions", "OpenAI Chat Completions"],
	["openai-responses", "OpenAI Responses"],
	["anthropic-messages", "Anthropic Messages"],
	["google-generative-ai", "Google Gemini"],
] as const;

function ModelEditor({
	draft,
	onChange,
	onRemove,
}: {
	draft: ModelDraft;
	onChange: (value: ModelConfig) => void;
	onRemove: () => void;
}) {
	const model = draft.value;
	const nativeMappings = useRef({ ...model.thinkingLevelMap });
	const levels = modelThinkingLevels(model);
	const update = (patch: Partial<ModelConfig>) => onChange({ ...model, ...patch });
	const toggleLevel = (level: ThinkingLevel) => {
		const selected = levels.includes(level);
		const next = THINKING_LEVELS.filter((candidate) =>
			candidate === level ? !selected : levels.includes(candidate),
		);
		const thinkingLevelMap = { ...model.thinkingLevelMap };
		if (selected) {
			if (typeof thinkingLevelMap[level] === "string")
				nativeMappings.current[level] = thinkingLevelMap[level];
			thinkingLevelMap[level] = null;
		} else if (typeof nativeMappings.current[level] === "string")
			thinkingLevelMap[level] = nativeMappings.current[level];
		else if (level === "xhigh" || level === "max") thinkingLevelMap[level] = level;
		else delete thinkingLevelMap[level];
		update({
			thinkingLevelMap,
			defaultThinkingLevel: next.includes(model.defaultThinkingLevel ?? "off")
				? model.defaultThinkingLevel
				: next[0],
		});
	};
	return (
		<fieldset
			aria-label={`模型 ${model.id || "未命名"}`}
			className="min-w-0 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-base)] p-4 sm:p-5"
		>
			<div className="mb-4 flex items-center justify-between gap-3">
				<span className="min-w-0 truncate text-sm font-medium">{model.id || "新模型"}</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={`删除模型 ${model.id || "未命名"}`}
					className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
					onClick={onRemove}
				>
					<Trash2 aria-hidden className="size-4" />
				</Button>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<label
					htmlFor={`${draft.key}-id`}
					className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-2"
				>
					模型 ID
					<Input
						id={`${draft.key}-id`}
						required
						value={model.id}
						placeholder="例如 deepseek-v4.1-flash"
						onChange={(event) => update({ id: event.target.value })}
					/>
				</label>
				<label
					htmlFor={`${draft.key}-context`}
					className="flex flex-col gap-2 text-xs text-muted-foreground"
				>
					上下文窗口 · contextWindow
					<Input
						id={`${draft.key}-context`}
						type="number"
						min={1}
						step={1}
						required
						value={model.contextWindow ?? ""}
						onChange={(event) =>
							update({
								contextWindow: event.target.value === "" ? undefined : Number(event.target.value),
							})
						}
					/>
				</label>
				<label
					htmlFor={`${draft.key}-output`}
					className="flex flex-col gap-2 text-xs text-muted-foreground"
				>
					最大输出 · maxTokens
					<Input
						id={`${draft.key}-output`}
						type="number"
						min={1}
						step={1}
						required
						value={model.maxTokens ?? ""}
						onChange={(event) =>
							update({
								maxTokens: event.target.value === "" ? undefined : Number(event.target.value),
							})
						}
					/>
				</label>
			</div>
			<div className="mt-5 flex items-center justify-between gap-4 border-t border-[var(--border-muted)] pt-4">
				<div>
					<span className="text-sm">思考模式</span>
					<p className="mt-1 text-xs text-muted-foreground">按模型实际能力开启</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={!!model.reasoning}
					aria-label="开启思考模式"
					onClick={() => {
						const reasoning = !model.reasoning;
						const supported = modelThinkingLevels({ ...model, reasoning });
						update({
							reasoning,
							defaultThinkingLevel: reasoning
								? supported.includes("medium")
									? "medium"
									: (supported.find((level) => level !== "off") ?? "off")
								: "off",
						});
					}}
					className={`relative h-6 w-10 shrink-0 rounded-full transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${model.reasoning ? "bg-primary" : "bg-[var(--border-base)]"}`}
				>
					<span
						aria-hidden
						className={`absolute top-0.5 size-5 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none ${model.reasoning ? "translate-x-[18px]" : "translate-x-0.5"} left-0`}
					/>
				</button>
			</div>
			{model.reasoning && (
				<div className="mt-4 space-y-4">
					<fieldset>
						<legend className="mb-2 text-xs text-muted-foreground">支持的思考强度 · 可多选</legend>
						<div className="flex flex-wrap gap-2">
							{THINKING_LEVELS.map((level) => (
								<button
									key={level}
									type="button"
									aria-pressed={levels.includes(level)}
									aria-label={`支持 ${level}`}
									title={level}
									disabled={
										level !== "off" &&
										levels.includes(level) &&
										levels.filter((item) => item !== "off").length === 1
									}
									onClick={() => toggleLevel(level)}
									className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed ${levels.includes(level) ? "border-primary/30 bg-primary/10 text-primary" : "border-[var(--border-muted)] text-muted-foreground hover:bg-[var(--overlay-hover)]"}`}
								>
									{levels.includes(level) && <Check aria-hidden className="size-3" />}
									{THINKING_LABELS[level]}
									<span className="opacity-70">{level}</span>
								</button>
							))}
						</div>
					</fieldset>
					<div className="sm:max-w-64">
						<SelectField
							id={`${draft.key}-default`}
							label="默认思考强度"
							value={model.defaultThinkingLevel ?? "off"}
							options={levels.map((level) => ({
								value: level,
								label: `${THINKING_LABELS[level]} · ${level}`,
							}))}
							onChange={(value) => update({ defaultThinkingLevel: value as ThinkingLevel })}
						/>
					</div>
				</div>
			)}
		</fieldset>
	);
}

export function ProviderEditor({
	draft,
	index,
	onChange,
	onRemove,
}: {
	draft: ProviderDraft;
	index: number;
	onChange: (draft: ProviderDraft) => void;
	onRemove: () => void;
}) {
	const [showKey, setShowKey] = useState(false);
	const update = (patch: Partial<ProviderDraft["settings"]>) =>
		onChange({ ...draft, settings: { ...draft.settings, ...patch } });
	return (
		<section
			aria-label={`Provider ${draft.id || index + 1}`}
			className="min-w-0 rounded-2xl border border-[var(--border-muted)] bg-[var(--bg-layer-01)] p-4 sm:p-6"
		>
			<div className="mb-5 flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-3">
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--bg-base)] text-xs text-muted-foreground tabular-nums">
						{String(index + 1).padStart(2, "0")}
					</span>
					<h2 className="truncate font-medium">{draft.id || "新 Provider"}</h2>
					<span className="shrink-0 text-xs text-muted-foreground">
						{draft.models.length} 个模型
					</span>
				</div>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					aria-label={`删除 Provider ${draft.id || index + 1}`}
					className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
					onClick={onRemove}
				>
					<Trash2 aria-hidden className="size-4" />
				</Button>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<label
					htmlFor={`${draft.key}-provider`}
					className="flex flex-col gap-2 text-xs text-muted-foreground"
				>
					Provider 标识
					<Input
						id={`${draft.key}-provider`}
						required
						value={draft.id}
						placeholder="例如 ali"
						autoCapitalize="none"
						spellCheck={false}
						onChange={(event) => onChange({ ...draft, id: event.target.value })}
					/>
				</label>
				<SelectField
					id={`${draft.key}-api`}
					label="API 协议"
					value={draft.settings.api ?? ""}
					options={[
						{ value: "", label: "按模型配置 / 默认" },
						...APIs.map(([value, label]) => ({ value, label })),
						...(draft.settings.api && !APIs.some(([api]) => api === draft.settings.api)
							? [{ value: draft.settings.api, label: draft.settings.api }]
							: []),
					]}
					onChange={(value) => update({ api: value || undefined })}
				/>
				<label
					htmlFor={`${draft.key}-url`}
					className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-2"
				>
					API 地址 · baseUrl
					<Input
						id={`${draft.key}-url`}
						type="url"
						value={draft.settings.baseUrl ?? ""}
						placeholder="https://api.example.com/v1"
						autoCapitalize="none"
						spellCheck={false}
						onChange={(event) => update({ baseUrl: event.target.value || undefined })}
					/>
				</label>
				<label
					htmlFor={`${draft.key}-key`}
					className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-2"
				>
					API Key
					<span className="relative block">
						<Input
							id={`${draft.key}-key`}
							type={showKey ? "text" : "password"}
							value={draft.settings.apiKey ?? ""}
							autoComplete="off"
							spellCheck={false}
							placeholder="填写访问密钥"
							className="pr-11"
							onChange={(event) => update({ apiKey: event.target.value || undefined })}
						/>
						<button
							type="button"
							aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
							className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
							onClick={() => setShowKey(!showKey)}
						>
							{showKey ? (
								<EyeOff aria-hidden className="size-4" />
							) : (
								<Eye aria-hidden className="size-4" />
							)}
						</button>
					</span>
				</label>
			</div>
			<div className="mb-3 mt-6 flex items-center justify-between">
				<h3 className="text-xs font-medium text-muted-foreground">模型</h3>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onChange({ ...draft, models: [...draft.models, newModel()] })}
				>
					<Plus aria-hidden className="size-3.5" />
					添加模型
				</Button>
			</div>
			<div className="space-y-3">
				{draft.models.map((model) => (
					<ModelEditor
						key={model.key}
						draft={model}
						onChange={(value) =>
							onChange({
								...draft,
								models: draft.models.map((item) =>
									item.key === model.key ? { ...item, value } : item,
								),
							})
						}
						onRemove={() =>
							onChange({ ...draft, models: draft.models.filter((item) => item.key !== model.key) })
						}
					/>
				))}
				{!draft.models.length && (
					<p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">
						暂无模型，点击「添加模型」开始配置
					</p>
				)}
			</div>
		</section>
	);
}
