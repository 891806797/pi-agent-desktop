import { expect, test } from "bun:test";
import { parseDOMToParts, partsToWire } from "../src/components/chat/chat-input/dom";

test("image chip to wire keeps the original MIME and bytes for every supported format", () => {
	const originalNode = Object.getOwnPropertyDescriptor(globalThis, "Node");
	Object.defineProperty(globalThis, "Node", { value: { TEXT_NODE: 3 }, configurable: true });
	try {
		for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/jpg"]) {
			const dataUrl = `data:${mime};base64,fixture`;
			const root = {
				childNodes: [
					{
						nodeType: 1,
						nodeName: "SPAN",
						dataset: { image: "true", filename: "fixture" },
						querySelector: () => ({ getAttribute: () => dataUrl }),
					},
				],
			} as unknown as HTMLElement;
			const payload = partsToWire(parseDOMToParts(root));
			expect(payload.attachments).toEqual([
				{
					type: "image",
					dataUrl,
					mime: mime === "image/jpg" ? "image/jpeg" : mime,
					filename: "fixture",
				},
			]);
		}
	} finally {
		if (originalNode) Object.defineProperty(globalThis, "Node", originalNode);
		else Reflect.deleteProperty(globalThis, "Node");
	}
});
