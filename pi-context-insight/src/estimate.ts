import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * Context-token estimates, kept in this package on purpose.
 *
 * The host injects only a fixed list of module IDs into extensions (the pi-ai
 * root plus `/compat`, `/models`, `/oauth` and `/providers/all`, see the
 * "Available Imports" table in pi's extensions doc). `pi-ai/utils/estimate`
 * resolves in a development tree, where the real package sits in
 * `node_modules`, but not in an extension installed with `pi install`, so an
 * import from there fails at startup with `Cannot find module`.
 *
 * The numbers below mirror pi-ai's own estimator: 3.5 characters per token and
 * a flat 4800 characters per image.
 */
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4800;

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return estimateTextTokens(content);
	let chars = 0;
	for (const block of content) {
		chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}
