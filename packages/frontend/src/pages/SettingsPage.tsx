import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getSettingsModels, listModels, putSettingsModels } from "@/lib/api";

export function SettingsPage() {
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [models, setModels] = useState<string[]>([]);

	useEffect(() => {
		void getSettingsModels()
			.then((r) => setText(JSON.stringify(r.models, null, 2)))
			.catch(() => setText('{\n  "providers": {}\n}\n'));
		void listModels()
			.then((r) => setModels(r.models.map((m) => `${m.provider}/${m.modelId}`)))
			.catch(() => {});
	}, []);

	async function save() {
		setError(null);
		setSaved(false);
		try {
			const parsed = JSON.parse(text);
			await putSettingsModels(parsed);
			setSaved(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : "JSON 解析或保存失败");
		}
	}

	return (
		<div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-3 bg-background p-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Provider 配置</h1>
				<Link to="/chat" className="inline-flex">
					<Button size="sm" variant="ghost">
						<ArrowLeft className="size-3.5" /> 返回聊天
					</Button>
				</Link>
			</div>
			<p className="text-xs text-muted-foreground">
				编辑 models.json（自定义 provider 的 baseUrl/apiKey/api/models）。保存后该用户 ModelRuntime
				缓存失效，下次取模型列表即生效。
			</p>
			<Textarea
				className="flex-1 resize-none font-mono text-xs"
				value={text}
				onChange={(e) => setText(e.target.value)}
				spellCheck={false}
			/>
			{models.length > 0 && (
				<details className="text-xs text-muted-foreground">
					<summary className="cursor-pointer">当前可用模型（{models.length}）</summary>
					<div className="mt-1 max-h-32 overflow-auto">{models.join(", ")}</div>
				</details>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{saved && <p className="text-sm text-green-600">已保存</p>}
			<Button onClick={() => void save()} className="self-end">
				<Save className="size-4" /> 保存
			</Button>
		</div>
	);
}
