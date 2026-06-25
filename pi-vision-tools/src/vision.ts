import type { AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type { VisionConfig } from "./config.js";
import type { DecodedImage } from "./image.js";
import type { ReasoningOptions } from "./reasoning.js";

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
	reasoning: ReasoningOptions;
	signal?: AbortSignal;
}

export interface VisionCallResult {
	text: string;
	usage?: { input?: number; output?: number };
	errorMessage?: string;
	stopReason?: string;
}

export type ResolveResult = { ok: true; model: Model<any> } | { ok: false; error: string };

interface ModelLookup {
	find(provider: string, id: string): Model<any> | undefined;
}

export function resolveVisionModel(registry: ModelLookup, config: VisionConfig): ResolveResult {
	if (!config.provider || !config.model) {
		return {
			ok: false,
			error: "Vision model not configured. Run: /vision config provider <p> ; /vision config model <m>",
		};
	}
	const model = registry.find(config.provider, config.model);
	if (!model) {
		return { ok: false, error: `Vision model not found: ${config.provider}/${config.model}` };
	}
	if (!Array.isArray(model.input) || !model.input.includes("image")) {
		return { ok: false, error: `Model ${config.provider}/${config.model} does not support image input` };
	}
	return { ok: true, model };
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
