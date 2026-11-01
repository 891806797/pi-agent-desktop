import type { Attachment } from "@/lib/agent-types";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type PromptPart =
	| { type: "text"; content: string }
	| { type: "file-mention"; path: string; label: string }
	| { type: "image-attachment"; dataUrl: string; mime: ImageMime; filename?: string };

export interface FileSearchHit {
	path: string;
	name: string;
	relativePath: string;
	score: number;
}

export interface WirePayload {
	message: string;
	attachments: Attachment[];
}
