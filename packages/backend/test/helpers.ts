import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { userAgentDir } from "../src/modules/system/paths";

export function configureTestModels(
	userId: string,
	ids = ["first", "second"],
	provider = "fixture",
) {
	writeFileSync(
		join(userAgentDir(userId), "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					api: "openai-completions",
					apiKey: "local-test",
					baseUrl: "http://127.0.0.1:9/v1",
					models: ids.map((id) => ({ id, reasoning: true, contextWindow: 8192, maxTokens: 256 })),
				},
			},
		}),
	);
}
