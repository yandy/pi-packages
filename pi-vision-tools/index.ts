import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { compressImage, readCompressionSettings } from "./src/compress.js";
import { loadConfig, saveConfig, THINK_LEVELS, type VisionConfig } from "./src/config.js";
import { type DecodedImage, decodeImage } from "./src/image.js";
import { effectiveThinkLevel, thinkLevelToOptions, type VisionThinkLevel } from "./src/think-level.js";
import { callingModelHasVision, footerLabel } from "./src/state.js";
import { callVision, resolveVisionModel } from "./src/vision.js";

const TOOL_NAME = "describe_image";
const STATUS_KEY = "pi-vision";

export default function (pi: ExtensionAPI) {
	let config: VisionConfig = {};
	let toolActive = false;

	const refresh = (ctx: ExtensionContext) => {
		toolActive = !callingModelHasVision(ctx.model);
		const current = pi.getActiveTools();
		if (toolActive && !current.includes(TOOL_NAME)) {
			pi.setActiveTools([...current, TOOL_NAME]);
		} else if (!toolActive && current.includes(TOOL_NAME)) {
			pi.setActiveTools(current.filter((t) => t !== TOOL_NAME));
		}
		if (ctx.hasUI) {
			const label = footerLabel(toolActive, resolveVisionModel(ctx.modelRegistry, config));
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
			"`thinkLevel` controls the vision model's thinking effort (off/minimal/low/medium/high/xhigh).",
		promptSnippet: "describe_image: delegate image analysis to a vision model (non-multimodal models).",
		promptGuidelines: [
			"Use describe_image when you need to understand an image you cannot see (the calling model lacks vision).",
			"Set compress:false when you need pixel-perfect accuracy (reading coordinates, tiny UI elements).",
			"Set thinkLevel:'high'/'xhigh' for complex visual analysis (architecture diagrams, bug hunting).",
		],
		parameters: Type.Object({
			image_path: Type.String({ description: "File path, data: URL, or raw base64 (>100 chars)." }),
			prompt: Type.String({
				description: "Instruction for the vision model, e.g. 'describe', 'extract text', 'find the bug'.",
			}),
			compress: Type.Optional(
				Type.Boolean({ default: true, description: "Compress image before sending (default true)." }),
			),
			thinkLevel: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description: "Vision model thinking effort. Default off.",
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
			if (!toolActive) {
				return {
					content: [{ type: "text", text: "describe_image is inactive: the calling model can see images itself." }],
					details: { error: "disabled" },
					isError: true,
				};
			}
			const p = params as { image_path: string; prompt: string; compress?: boolean; thinkLevel?: VisionThinkLevel };

			const resolved = resolveVisionModel(ctx.modelRegistry, config);
			if (!resolved.ok) {
				return { content: [{ type: "text", text: resolved.error }], details: { error: resolved.error }, isError: true };
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
			if (!auth.ok || !auth.apiKey) {
				const msg = auth.ok ? `No API key for ${resolved.model.provider}/${resolved.model.id}` : auth.error;
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

			const thinkLevel = effectiveThinkLevel(p.thinkLevel, config.defaultThinkLevel);
			const thinkLevelOptions = thinkLevelToOptions(thinkLevel);
			const result = await callVision(
				{
					model: resolved.model,
					auth: { apiKey: auth.apiKey, headers: auth.headers },
					prompt: p.prompt,
					images: [image],
					reasoning: thinkLevelOptions,
					signal: signal ?? undefined,
				},
				complete,
			);

			if (result.errorMessage) {
				return {
					content: [{ type: "text", text: `Vision model error: ${result.errorMessage}` }],
					details: { error: result.errorMessage, model: `${resolved.model.provider}/${resolved.model.id}` },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: result.text }],
				details: {
					model: `${resolved.model.provider}/${resolved.model.id}`,
					usage: result.usage,
					compressed,
					mimeType,
					thinkLevel,
				},
			};
		},
	});

	pi.registerCommand("vision", {
		description:
			"Configure the vision model for describe_image (/vision status | config model <m> | config default-think-level <level>)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			const notifyConfig = () => {
				const resolved = resolveVisionModel(ctx.modelRegistry, config);
				const target = !config.model
					? "(unconfigured)"
					: resolved.ok
						? `${resolved.model.provider}/${resolved.model.id}`
						: `${config.model} (unresolved)`;
				const lines = [
					`vision: ${target}`,
					`default think level: ${config.defaultThinkLevel ?? "off (built-in)"}`,
					`active: ${toolActive ? "yes" : "no"} (calling model has vision: ${callingModelHasVision(ctx.model) ? "yes" : "no"})`,
				];
				if (config.model && !resolved.ok) lines.push(resolved.error);
				ctx.ui.notify(lines.join("\n"), "info");
			};

			if (!sub || sub === "status") {
				notifyConfig();
				return;
			}

			if (sub === "config") {
				const key = parts[1];
				const val = parts.slice(2).join(" ") || undefined;
				if (key === "model" && val) {
					config = { ...config, model: val };
				} else if (key === "default-think-level" && val) {
					if (!(THINK_LEVELS as readonly string[]).includes(val)) {
						ctx.ui.notify(`Invalid think level "${val}". Valid: ${THINK_LEVELS.join(", ")}`, "warning");
						return;
					}
					config = { ...config, defaultThinkLevel: val as VisionThinkLevel };
				} else {
					ctx.ui.notify("Usage: /vision config model <m> | default-think-level <level>", "warning");
					return;
				}
				await saveConfig(getAgentDir(), config);
				refresh(ctx);
				if (key === "model") {
					const resolved = resolveVisionModel(ctx.modelRegistry, config);
					if (resolved.ok) ctx.ui.notify(`vision model = ${resolved.model.provider}/${resolved.model.id}`, "info");
					else ctx.ui.notify(resolved.error, "warning");
				} else {
					ctx.ui.notify(`vision default-think-level = ${val}`, "info");
				}
				return;
			}

			ctx.ui.notify("Usage: /vision [status | config model <m> | config default-think-level <level>]", "warning");
		},
	});
}
