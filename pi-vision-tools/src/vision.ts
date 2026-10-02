import type { AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type { VisionConfig } from "./config.js";
import type { DecodedImage } from "./image.js";
import { resolveModel, type VisionModelRegistry } from "./model-resolver.js";
import type { ThinkLevelOptions } from "./think-level.js";

export type CompleteFn = (
	model: Model<any>,
	context: Context,
	options?: Record<string, unknown>,
) => Promise<AssistantMessage>;

export interface VisionCallInput {
	model: Model<any>;
	auth: { apiKey?: string; headers?: Record<string, string> };
	prompt: string;
	images: DecodedImage[];
	reasoning: ThinkLevelOptions;
	signal?: AbortSignal;
}

export interface VisionCallResult {
	text: string;
	usage?: { input?: number; output?: number };
	errorMessage?: string;
	stopReason?: string;
}

export type ResolveResult = { ok: true; model: Model<any> } | { ok: false; error: string };

/**
 * Resolve the configured vision model. The configured string is either
 * "provider/id" or a fuzzy name; resolution also rejects models without image input.
 */
export function resolveVisionModel(registry: VisionModelRegistry, config: VisionConfig): ResolveResult {
	if (!config.model?.trim()) {
		return { ok: false, error: "Vision model not configured. Run: /vision config model <m>" };
	}
	const resolved = resolveModel(config.model, registry);
	if (typeof resolved === "string") return { ok: false, error: resolved };
	return { ok: true, model: resolved };
}

export async function callVision(input: VisionCallInput, completeFn: CompleteFn): Promise<VisionCallResult> {
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: input.prompt },
			...input.images.map((img) => ({
				type: "image" as const,
				data: img.data.toString("base64"),
				mimeType: img.mimeType,
			})),
		],
		timestamp: Date.now(),
	};

	const context: Context = { messages: [userMessage] };

	const options: Record<string, unknown> = {
		apiKey: input.auth.apiKey,
		headers: input.auth.headers,
		...input.reasoning,
	};
	if (input.signal) options.signal = input.signal;

	try {
		const res = await completeFn(input.model, context, options);
		const text = res.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return {
			text,
			usage: { input: res.usage?.input, output: res.usage?.output },
			stopReason: res.stopReason,
			errorMessage: res.errorMessage,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { text: "", errorMessage: msg };
	}
}
