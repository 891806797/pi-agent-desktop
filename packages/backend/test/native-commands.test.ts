import { expect, test } from "bun:test";
import { listCommands } from "../src/modules/agent/commands";
import type { SessionContext } from "../src/modules/agent/session-registry";

test("clean Web sessions expose the supported native commands without Claude-only placeholders", () => {
	const ctx = {
		session: { extensionRunner: { getRegisteredCommands: () => [] } },
		resourceLoader: { getPrompts: () => ({ prompts: [] }), getSkills: () => ({ skills: [] }) },
	} as unknown as SessionContext;
	expect(listCommands(ctx).map((command) => command.name)).toEqual(["new", "compact"]);
});
