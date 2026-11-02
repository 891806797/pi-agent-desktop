import { registry } from "../../src/modules/agent/session-registry";
import { installHostShutdown } from "../../src/modules/system/desktop-host";
import { configureTestModels } from "../helpers";

configureTestModels("desktop-shell");
const ctx = await registry.create({ userId: "desktop-shell", username: "user" }, process.cwd());
installHostShutdown(
	() => registry.stop({ preserveRunning: true }),
	() => {},
);
const running = process.argv[2] === "running";
const command = running
	? "sleep 90 & echo $!; wait"
	: "sleep 90 </dev/null >/dev/null 2>&1 & echo $!";
const tool = ctx.session.agent.state.tools.find((tool) => tool.name === "bash")!;
const result = await tool.execute(
	"owned-background",
	{ command },
	undefined,
	running
		? (update) => {
				const output = update.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("");
				if (Number(output.trim()) > 0)
					console.log(JSON.stringify({ ready: true, pids: [Number(output.trim())] }));
			}
		: undefined,
);
const output = result.content
	.filter((item) => item.type === "text")
	.map((item) => item.text)
	.join("");
const userBash = await ctx.session.extensionRunner.emitUserBash({
	type: "user_bash",
	command,
	excludeFromContext: false,
	cwd: process.cwd(),
});
if (!userBash?.operations) throw new Error("desktop user_bash operations missing");
const bash = await ctx.session.executeBash(command, undefined, { operations: userBash.operations });
console.log(
	JSON.stringify({ ready: true, pids: [Number(output.trim()), Number(bash.output.trim())] }),
);
