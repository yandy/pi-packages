import type { Model } from "@earendil-works/pi-ai";
import type { VisionConfig } from "./config.js";

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

export function footerLabel(config: VisionConfig, enabled: boolean): string | undefined {
	if (!enabled) return undefined;
	if (!config.provider || !config.model) return undefined;
	return `👁 ${config.provider}/${config.model}`;
}
