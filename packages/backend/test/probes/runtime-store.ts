import { RuntimeStore } from "../../src/modules/agent/runtime-store";

const store = new RuntimeStore(Bun.argv[2]!);
store.write({
	version: 1,
	userId: "probe",
	username: "probe",
	sessionId: "probe",
	cwd: process.cwd(),
	active: true,
	inputs: [],
	approvals: [],
	tools: [],
});
if (store.read("probe", "probe")?.active !== true)
	throw new Error("compiled runtime checkpoint failed");
store.close();
console.log("COMPILED_DRIZZLE_PASS");
