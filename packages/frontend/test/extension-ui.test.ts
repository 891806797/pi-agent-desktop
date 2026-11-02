import { afterEach, expect, test } from "bun:test";
import { emptyExtensionUI } from "@pi-agent/common";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtensionPanel } from "../src/components/chat/ExtensionPanel";
import { useChatStore } from "../src/stores/chat";

afterEach(() => useChatStore.getState().reset());

test("extension text respects placement, newlines and HTML escaping in the real component", () => {
	const ui = {
		...emptyExtensionUI(),
		statuses: { build: "准备\n就绪" },
		widgets: {
			above: { placement: "aboveEditor" as const, lines: ["first", "<script>unsafe()</script>"] },
			below: { placement: "belowEditor" as const, lines: ["below-only"] },
		},
	};
	const above = renderToStaticMarkup(
		createElement(ExtensionPanel, { ui, placement: "aboveEditor" }),
	);
	expect(above).toContain("准备\n就绪");
	expect(above).toContain("first\n&lt;script&gt;");
	expect(above).not.toContain("<script>");
	expect(above).not.toContain("below-only");
	const below = renderToStaticMarkup(
		createElement(ExtensionPanel, { ui, placement: "belowEditor" }),
	);
	expect(below).toContain("below-only");
	expect(below).not.toContain("准备");
});

test("extension updates replace the snapshot, notifications deduplicate and switching clears transient UI", () => {
	const store = useChatStore.getState();
	store.applyEvent({
		seq: 1,
		event: "extension_ui",
		data: { ...emptyExtensionUI(), statuses: { build: "working" } },
	});
	store.applyEvent({ seq: 2, event: "extension_ui", data: emptyExtensionUI() });
	expect(useChatStore.getState().ui.statuses).toEqual({});
	const event = {
		seq: 3,
		event: "extension_notify" as const,
		data: { id: "one", type: "warning" as const, message: "check" },
	};
	store.applyEvent(event);
	store.applyEvent({ ...event, seq: 4 });
	expect(useChatStore.getState().notifications).toHaveLength(1);
	store.reset();
	expect(useChatStore.getState().ui).toEqual(emptyExtensionUI());
	expect(useChatStore.getState().notifications).toEqual([]);
});
