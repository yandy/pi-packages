import type { Usage } from "@earendil-works/pi-ai";

/** Complete provider usage fixture; overrides may replace scalar fields or individual cost components. */
export function makeUsage(
	overrides: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> } = {},
): Usage {
	const { cost, ...rest } = overrides;
	return {
		input: 100,
		output: 50,
		cacheRead: 20,
		cacheWrite: 10,
		totalTokens: 180,
		...rest,
		cost: {
			input: 0.01,
			output: 0.02,
			cacheRead: 0.001,
			cacheWrite: 0.005,
			total: 0.036,
			...cost,
		},
	};
}
