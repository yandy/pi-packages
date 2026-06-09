export interface TierSpec {
	memory: string;
	swap: string;
	cpus: string;
	pidsLimit?: number;
}

export type SizeTier = "small" | "medium" | "large";

export const TIER_SPECS: Record<SizeTier, TierSpec> = {
	small: { memory: "1g", swap: "512m", cpus: "1" },
	medium: { memory: "4g", swap: "2g", cpus: "2" },
	large: { memory: "8g", swap: "4g", cpus: "4" },
};

export function parseSizeTier(tier: string): SizeTier | null {
	if (tier in TIER_SPECS) return tier as SizeTier;
	return null;
}
