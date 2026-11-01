import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@/core/app-error";
import { userAgentDir } from "@/modules/system/paths";
import { registry } from "./session-registry";

const modelSettingsWrites = new Map<string, Promise<void>>();
export async function listModels(userId: string) {
	const runtime = await registry.modelRuntimeFor(userId);
	const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(8000) });
	return available.map((model) => ({
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
	}));
}

export function getModelSettings(userId: string): unknown {
	try {
		return JSON.parse(readFileSync(join(userAgentDir(userId), "models.json"), "utf8"));
	} catch {
		return { providers: {} };
	}
}

export async function saveModelSettings(userId: string, input: unknown): Promise<void> {
	const file = join(userAgentDir(userId), "models.json");
	const previous = modelSettingsWrites.get(userId) ?? Promise.resolve();
	const save = previous
		.catch(() => {})
		.then(async () => {
			const runtime = await registry.modelRuntimeFor(userId);
			let old: string | undefined;
			try {
				old = readFileSync(file, "utf8");
			} catch {
				/* 首次配置 */
			}
			const temporary = `${file}.${crypto.randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify(input, null, 2)}\n`, "utf8");
				renameSync(temporary, file);
			} catch (error) {
				try {
					unlinkSync(temporary);
				} catch {
					/* 写入尚未创建临时文件 */
				}
				throw error;
			}
			try {
				await registry.invalidateModelRuntime(userId);
				const error = runtime.getError();
				if (error) throw new AppError("BAD_REQUEST", error);
			} catch (error) {
				if (old === undefined) unlinkSync(file);
				else writeFileSync(file, old, "utf8");
				await registry.invalidateModelRuntime(userId);
				throw error;
			}
		});
	modelSettingsWrites.set(userId, save);
	try {
		await save;
	} finally {
		if (modelSettingsWrites.get(userId) === save) modelSettingsWrites.delete(userId);
	}
}
