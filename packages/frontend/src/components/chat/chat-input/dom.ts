import type { Attachment } from "@/lib/agent-types";
import type { ImageMime, PromptPart, WirePayload } from "./types";

/** 光标在 root.textContent 中的字符偏移（contenteditable 标准 caret 定位法） */
export function getCaretOffset(root: HTMLElement): number {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return root.textContent?.length ?? 0;
	const range = sel.getRangeAt(0);
	if (!root.contains(range.endContainer)) return root.textContent?.length ?? 0;
	const pre = range.cloneRange();
	pre.selectNodeContents(root);
	pre.setEnd(range.endContainer, range.endOffset);
	return pre.toString().length;
}

/** 光标前的文本（用于 @ / / 触发检测） */
export function getTextBeforeCaret(root: HTMLElement): string {
	return (root.textContent ?? "").slice(0, getCaretOffset(root));
}

/** 把 range 起点向前扩展到 `@query`（匹配则 range 覆盖 @query） */
export function extendRangeToAt(range: Range): boolean {
	const node = range.startContainer;
	if (node.nodeType !== Node.TEXT_NODE) return false;
	const text = node.textContent ?? "";
	const caret = range.startOffset;
	const slice = text.slice(0, caret);
	const match = slice.match(/(?:^|\s)@([^\s@]*)$/);
	if (!match) return false;
	const atIdx = slice.lastIndexOf("@");
	if (atIdx < 0) return false;
	range.setStart(node, atIdx);
	return true;
}

/** 把 range 起点向前扩展到行首的 `/query` */
export function extendRangeToSlash(range: Range): boolean {
	const node = range.startContainer;
	if (node.nodeType !== Node.TEXT_NODE) return false;
	const text = node.textContent ?? "";
	const caret = range.startOffset;
	const slice = text.slice(0, caret);
	const match = slice.match(/(?:^|\n)\/([^\s/]*)$/);
	if (!match) return false;
	const slashIdx = slice.lastIndexOf("/");
	if (slashIdx < 0) return false;
	range.setStart(node, slashIdx);
	return true;
}

/** 创建 @file chip span（contenteditable=false） */
export function createChipSpan(path: string, label: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className =
		"inline-flex items-center rounded-md bg-blue-100 text-blue-700 px-1.5 py-0.5 text-[12px] font-mono align-middle mx-0.5";
	span.setAttribute("contenteditable", "false");
	span.dataset.mention = "file";
	span.dataset.path = path;
	span.dataset.label = label;
	span.textContent = label;
	return span;
}

/** 创建 image chip span */
export function createImageChipSpan(dataUrl: string, filename: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className =
		"inline-flex items-center gap-1 rounded-md bg-purple-100 text-purple-700 px-1 py-0.5 align-middle mx-0.5";
	span.setAttribute("contenteditable", "false");
	span.dataset.image = "true";
	span.dataset.filename = filename;
	const img = document.createElement("img");
	img.src = dataUrl;
	img.alt = filename;
	img.className = "size-4 rounded";
	span.appendChild(img);
	const label = document.createElement("span");
	label.textContent = filename;
	span.appendChild(label);
	return span;
}

/** 从 contenteditable DOM 解析回 PromptPart[]（处理 <br>/<div> 换行、chip span） */
export function parseDOMToParts(root: HTMLElement): PromptPart[] {
	const parts: PromptPart[] = [];
	let buffer = "";
	const flush = (): void => {
		if (buffer) {
			parts.push({ type: "text", content: buffer });
			buffer = "";
		}
	};
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			buffer += node.textContent ?? "";
			return;
		}
		if (node.nodeName === "BR") {
			buffer += "\n";
			return;
		}
		const el = node as HTMLElement;
		if (el.dataset?.mention === "file") {
			flush();
			parts.push({
				type: "file-mention",
				path: el.dataset.path ?? "",
				label: el.dataset.label ?? el.textContent ?? "",
			});
			return;
		}
		if (el.dataset?.image) {
			flush();
			const img = el.querySelector("img");
			const dataUrl = img?.getAttribute("src") ?? "";
			const mediaType = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,/i
				.exec(dataUrl)?.[1]
				?.toLowerCase();
			if (!mediaType) throw new Error("不支持的图片格式，请使用 PNG、JPEG、GIF 或 WebP");
			parts.push({
				type: "image-attachment",
				dataUrl,
				mime: (mediaType === "image/jpg" ? "image/jpeg" : mediaType) as ImageMime,
				filename: el.dataset.filename,
			});
			return;
		}
		// 块级元素（DIV/P）：前补换行再递归
		if (node.nodeName === "DIV" || node.nodeName === "P") {
			if (buffer && !buffer.endsWith("\n")) buffer += "\n";
			node.childNodes.forEach(walk);
			return;
		}
		// 其他 inline：递归子节点
		node.childNodes.forEach(walk);
	};
	root.childNodes.forEach(walk);
	flush();
	return mergeTextParts(parts);
}

function mergeTextParts(parts: PromptPart[]): PromptPart[] {
	const out: PromptPart[] = [];
	for (const p of parts) {
		const last = out[out.length - 1];
		if (last && last.type === "text" && p.type === "text") {
			last.content += p.content;
		} else {
			out.push(p);
		}
	}
	return out;
}

/** parts → 提交载荷：@path 保留在 message 文本 + file attachment */
export function partsToWire(parts: PromptPart[]): WirePayload {
	let message = "";
	const attachments: Attachment[] = [];
	for (const p of parts) {
		if (p.type === "text") {
			message += p.content;
		} else if (p.type === "file-mention") {
			message += `@${/[\s"\\]/.test(p.path) ? JSON.stringify(p.path) : p.path}`;
			attachments.push({ type: "file", path: p.path });
		} else if (p.type === "image-attachment") {
			message += `[image: ${p.filename ?? "image"}]`;
			attachments.push({
				type: "image",
				dataUrl: p.dataUrl,
				mime: p.mime,
				...(p.filename ? { filename: p.filename } : {}),
			});
		}
	}
	return { message: message.trim(), attachments };
}

/** 取光标前一个 chip 节点（backspace 删除检测用） */
export function getChipBeforeCaret(root: HTMLElement): HTMLElement | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!range.collapsed) return null;
	const node: Node | null = range.startContainer;
	if (node.nodeType === Node.TEXT_NODE && range.startOffset > 0) return null;
	// 光标在 text node 开头或 chip 后：找前一个兄弟 chip
	let prev: Node | null =
		node.nodeType === Node.TEXT_NODE && range.startOffset === 0
			? node.previousSibling
			: range.startContainer;
	// 若光标在 chip 之后（startContainer 是 chip 的父，startOffset 指向 chip 之后）
	if (node === root && range.startOffset > 0) {
		prev = root.childNodes[range.startOffset - 1] ?? null;
	}
	while (prev) {
		if (prev.nodeType === Node.ELEMENT_NODE) {
			const el = prev as HTMLElement;
			if (el.dataset?.mention || el.dataset?.image) return el;
		}
		prev = prev.previousSibling;
	}
	return null;
}

/** Only clear the exact draft acknowledged by the server; edits made while waiting stay intact. */
export async function submitDraft(
	root: Pick<HTMLElement, "innerHTML" | "replaceChildren">,
	send: () => Promise<boolean>,
	unchanged: () => boolean,
): Promise<boolean> {
	const html = root.innerHTML;
	if (!(await send()) || root.innerHTML !== html || !unchanged()) return false;
	root.replaceChildren();
	return true;
}
