import type { Model } from "@earendil-works/pi-ai";
import type { ResolveResult } from "./vision.js";

// biome-ignore lint/suspicious/noExplicitAny: generic Model type parameter
export function callingModelHasVision(model: Model<any> | undefined): boolean {
	return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/** Footer indicator for the resolved vision model. Hidden while the tool is inactive or the model cannot be resolved. */
export function footerLabel(enabled: boolean, resolved: ResolveResult | undefined): string | undefined {
	if (!enabled || !resolved?.ok) return undefined;
	return `👁 ${resolved.model.provider}/${resolved.model.id}`;
}
