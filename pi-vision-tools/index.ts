import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { compressImage, readCompressionSettings } from "./src/compress.js";
import { loadConfig, saveConfig, type VisionConfig } from "./src/config.js";
import { type DecodedImage, decodeImage } from "./src/image.js";
import { effectiveReasoning, reasoningToOptions, type VisionReasoning } from "./src/reasoning.js";
import { callingModelHasVision, effectiveEnabled, footerLabel } from "./src/state.js";
import { callVision, resolveVisionModel } from "./src/vision.js";

const TOOL_NAME = "describe_image";
const STATUS_KEY = "pi-vision";

export default function (pi: ExtensionAPI) {
	let config: VisionConfig = { enabled: "auto" };
	let enabled = false;

	const refresh = (ctx: ExtensionContext) => {
		enabled = effectiveEnabled(config, ctx.model);
		const active = pi.getActiveTools();
		if (enabled && !active.includes(TOOL_NAME)) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!enabled && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
		}
		if (ctx.hasUI) {
			const label = footerLabel(config, enabled);
			ctx.ui.setStatus(STATUS_KEY, label);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(getAgentDir());
		refresh(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Describe Image",
		description:
			"Analyze an image by delegating to a vision-capable model. Lets non-multimodal models understand images. " +
			"`image_path` is a file path, data: URL, or raw base64 (>100 chars). " +
			"`compress` (default true) downscales/strips to speed up; set false for pixel-perfect needs. " +
			"`reasoning` controls the vision model's thinking effort (off/minimal/low/medium/high/xhigh).",
		promptSnippet: "describe_image: delegate image analysis to a vision model (non-multimodal models).",
		promptGuidelines: [
			"Use describe_image when you need to understand an image you cannot see (the calling model lacks vision).",
			"Set compress:false when you need pixel-perfect accuracy (reading coordinates, tiny UI elements).",
			"Set reasoning:'high'/'xhigh' for complex visual analysis (architecture diagrams, bug hunting).",
		],
		parameters: Type.Object({
			image_path: Type.String({ description: "File path, data: URL, or raw base64 (>100 chars)." }),
			prompt: Type.String({
				description: "Instruction for the vision model, e.g. 'describe', 'extract text', 'find the bug'.",
			}),
			compress: Type.Optional(
				Type.Boolean({ default: true, description: "Compress image before sending (default true)." }),
			),
			reasoning: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description: "Vision model reasoning effort. Default off.",
				}),
			),
		}),
		renderCall(args, theme) {
			const p = args as { image_path?: string; prompt?: string };
			const target = p.image_path ? (p.image_path.length > 40 ? `${p.image_path.slice(0, 37)}...` : p.image_path) : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("describe_image ")) +
					theme.fg("accent", target) +
					theme.fg("dim", ` · ${p.prompt?.slice(0, 30) ?? ""}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content?.[0];
			const body = text?.type === "text" ? text.text : "";
			const lines = body.split("\n");
			if (!expanded) {
				const preview = lines.slice(0, 6);
				if (lines.length > 6) preview.push(theme.fg("dim", `... ${lines.length - 6} more lines · ctrl+o to expand`));
				return new Text(preview.join("\n"), 0, 0);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [{ type: "text", text: "describe_image is disabled. Run /vision on to enable." }],
					details: { error: "disabled" },
					isError: true,
				};
			}
			const p = params as { image_path: string; prompt: string; compress?: boolean; reasoning?: VisionReasoning };

			const resolved = resolveVisionModel(ctx.modelRegistry, config);
			if (!resolved.ok) {
				return { content: [{ type: "text", text: resolved.error }], details: { error: resolved.error }, isError: true };
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
			if (!auth.ok || !auth.apiKey) {
				const msg = auth.ok ? `No API key for ${config.provider}/${config.model}` : auth.error;
				return { content: [{ type: "text", text: msg }], details: { error: msg }, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: "Decoding image..." }], details: {} });

			let image: DecodedImage;
			try {
				image = await decodeImage(p.image_path);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text", text: `Image decode failed: ${msg}` }], details: { error: msg }, isError: true };
			}

			const doCompress = p.compress !== false;
			let compressed = false;
			let mimeType = image.mimeType;
			if (doCompress) {
				onUpdate?.({ content: [{ type: "text", text: "Compressing..." }], details: {} });
				const out = await compressImage(image, readCompressionSettings());
				compressed = out !== image;
				mimeType = out.mimeType;
				image = out;
			}

			onUpdate?.({ content: [{ type: "text", text: "Analyzing image..." }], details: {} });

			const reasoningLevel = effectiveReasoning(p.reasoning, config.defaultReasoning);
			const reasoning = reasoningToOptions(reasoningLevel);
			const result = await callVision(
				{
					model: resolved.model,
					auth: { apiKey: auth.apiKey, headers: auth.headers },
					prompt: p.prompt,
					images: [image],
					reasoning,
					signal: signal ?? undefined,
				},
				complete,
			);

			if (result.errorMessage) {
				return {
					content: [{ type: "text", text: `Vision model error: ${result.errorMessage}` }],
					details: { error: result.errorMessage, model: `${config.provider}/${config.model}` },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: result.text }],
				details: {
					model: `${config.provider}/${config.model}`,
					usage: result.usage,
					compressed,
					mimeType,
					reasoning: reasoningLevel,
				},
			};
		},
	});

	pi.registerCommand("vision", {
		description: "Configure the vision model for describe_image (/vision config | on | off | status)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			const notifyConfig = () => {
				const target = config.provider && config.model ? `${config.provider}/${config.model}` : "(unconfigured)";
				const visionCap = callingModelHasVision(ctx.model) ? "yes" : "no";
				ctx.ui.notify(
					`vision: ${target}\nenabled: ${config.enabled} (effective: ${enabled ? "on" : "off"})\ncalling model has vision: ${visionCap}`,
					"info",
				);
			};

			if (!sub || sub === "status") {
				notifyConfig();
				return;
			}

			if (sub === "on" || sub === "off" || sub === "auto") {
				config = { ...config, enabled: sub as VisionConfig["enabled"] };
				await saveConfig(getAgentDir(), config);
				refresh(ctx);
				ctx.ui.notify(`vision ${sub}`, "info");
				return;
			}

			if (sub === "config") {
				const key = parts[1];
				const val = parts[2];
				if (key === "provider" && val) config = { ...config, provider: val };
				else if (key === "model" && val) config = { ...config, model: val };
				else if (key === "default-reasoning" && val) config = { ...config, defaultReasoning: val as VisionReasoning };
				else {
					ctx.ui.notify("Usage: /vision config provider <p> | model <m> | default-reasoning <level>", "warning");
					return;
				}
				await saveConfig(getAgentDir(), config);
				refresh(ctx);
				ctx.ui.notify(`vision ${key} = ${val}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /vision [config provider <p> | config model <m> | on | off | auto | status]", "warning");
		},
	});
}
