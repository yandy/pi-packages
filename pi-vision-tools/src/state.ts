import type { Model } from "@earendil-works/pi-ai";
import type { VisionConfig } from "./config.js";
import type { ResolveResult } from "./vision.js";

// biome-ignore lint/suspicious/noExplicitAny: generic Model type parameter
export function callingModelHasVision(model: Model<any> | undefined): boolean {
	return !!model && Array.isArray(model.input) && model.input.includes("image");
}

// biome-ignore lint/suspicious/noExplicitAny: generic Model type parameter
export function effectiveEnabled(config: VisionConfig, model: Model<any> | undefined): boolean {
	if (config.enabled === "on") return true;
	if (config.enabled === "off") return false;
	return !callingModelHasVision(model);
}

/** Footer indicator for the resolved vision model. Hidden while the tool is off or the model cannot be resolved. */
export function footerLabel(enabled: boolean, resolved: ResolveResult | undefined): string | undefined {
	if (!enabled || !resolved?.ok) return undefined;
	return `👁 ${resolved.model.provider}/${resolved.model.id}`;
}
