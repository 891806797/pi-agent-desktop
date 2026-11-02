import { installHostShutdown } from "../../src/modules/system/desktop-host";

installHostShutdown(
	async () => {
		if (process.argv[2] === "fail") throw new Error("fixture failure");
		await new Promise(() => {});
	},
	() => {},
);
console.log(
	JSON.stringify({ installed: true, tokenInherited: process.env.PI_DESKTOP_TOKEN !== undefined }),
);
