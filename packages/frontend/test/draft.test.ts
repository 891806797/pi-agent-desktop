import { expect, test } from "bun:test";
import { submitDraft } from "../src/components/chat/chat-input/dom";

function draft() {
	return {
		innerHTML: 'text <span data-image="image">picture</span>',
		replaceChildren() {
			this.innerHTML = "";
		},
	};
}
test("REST rejection preserves text and image draft until server accepts", async () => {
	const root = draft();
	const original = root.innerHTML;
	let reply!: (accepted: boolean) => void;
	const submitted = submitDraft(
		root,
		() =>
			new Promise((resolve) => {
				reply = resolve;
			}),
		() => true,
	);
	expect(root.innerHTML).toBe(original);
	reply(false);
	expect(await submitted).toBe(false);
	expect(root.innerHTML).toBe(original);
	expect(
		await submitDraft(
			root,
			async () => true,
			() => true,
		),
	).toBe(true);
	expect(root.innerHTML).toBe("");
});
test("successful old request cannot clear edits or a replacement session draft", async () => {
	for (const changed of ["edit", "session"]) {
		const root = draft();
		let reply!: (accepted: boolean) => void;
		let current = true;
		const p = submitDraft(
			root,
			() =>
				new Promise((resolve) => {
					reply = resolve;
				}),
			() => current,
		);
		if (changed === "edit") root.innerHTML = "new draft";
		else current = false;
		const expected = root.innerHTML;
		reply(true);
		expect(await p).toBe(false);
		expect(root.innerHTML).toBe(expected);
	}
});
