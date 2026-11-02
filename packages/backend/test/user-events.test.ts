import { expect, test } from "bun:test";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { UserEventHub } from "../src/modules/agent/user-events";

test("user replay detects process epochs even when sequence numbers coincide", () => {
	const old = new UserEventHub();
	old.publish({ event: "session_removed", data: { sessionId: "one" } });
	const next = new UserEventHub();
	next.publish({ event: "session_removed", data: { sessionId: "two" } });
	expect(next.replay(old.epoch, 1)).toBeUndefined();
	expect(next.replay(next.epoch, 0)).toHaveLength(1);
});

test("session streams carry a stable epoch distinct from a replacement instance", () => {
	const one = new SessionEventBus();
	const two = new SessionEventBus();
	expect(typeof one.epoch).toBe("string");
	expect(one.epoch).not.toBe(two.epoch);
});
