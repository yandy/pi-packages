import type { Model } from "@earendil-works/pi-ai";

/**
 * Structural subset of the pi model registry the resolver needs.
 * Kept structural (not the `ModelRegistry` class) so tests can fake it.
 */
export interface VisionModelRegistry {
	find(provider: string, id: string): Model<any> | undefined;
	getAll(): Model<any>[];
	getAvailable?(): Model<any>[];
}

function hasImageInput(model: Model<any>): boolean {
	return Array.isArray(model.input) && model.input.includes("image");
}

function visionList(models: Model<any>[]): string {
	return models
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n");
}

function cannotAcceptImages(input: string, vision: Model<any>[]): string {
	return `Model "${input}" does not support image input.\n\nAvailable vision models:\n${visionList(vision)}`;
}

/** Score: exact id / full name 100, id substring 60+, display-name substring 40+, all query parts present 20. */
function scoreModel(query: string, m: Model<any>): number {
	const id = m.id.toLowerCase();
	const name = m.name.toLowerCase();
	const full = `${m.provider}/${m.id}`.toLowerCase();

	if (id === query || full === query) return 100;
	if (id.includes(query) || full.includes(query)) return 60 + (query.length / id.length) * 30;
	if (name.includes(query)) return 40 + (query.length / name.length) * 20;
	if (
		query
			.split(/[\s\-/]+/)
			.every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
	) {
		return 20;
	}
	return 0;
}

function bestMatch(query: string, models: Model<any>[]): Model<any> | undefined {
	let best: Model<any> | undefined;
	let bestScore = 0;
	for (const m of models) {
		const score = scoreModel(query, m);
		if (score > bestScore) {
			bestScore = score;
			best = m;
		}
	}
	return bestScore >= 20 ? best : undefined;
}

/**
 * Resolve a configured model string to a Model instance.
 *
 * Accepts "provider/modelId" (exact, when available with auth) or a fuzzy name
 * ("haiku", "qwen vl", "provider haiku"). Only models with image input are eligible.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(input: string, registry: VisionModelRegistry): Model<any> | string {
	const query = input.trim().toLowerCase();
	if (!query) return "Vision model not configured. Run: /vision config model <m>";

	// Available models (those with auth configured)
	const all = registry.getAvailable?.() ?? registry.getAll();
	const vision = all.filter(hasImageInput);

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = query.indexOf("/");
	if (slashIdx !== -1) {
		const provider = query.slice(0, slashIdx);
		const id = query.slice(slashIdx + 1);
		const exact = all.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
		if (exact) {
			if (!hasImageInput(exact)) return cannotAcceptImages(input, vision);
			return registry.find(exact.provider, exact.id) ?? exact;
		}
	}

	// 2. Fuzzy match against vision-capable models
	const best = bestMatch(query, vision);
	if (best) return registry.find(best.provider, best.id) ?? best;

	// 3. A fuzzy hit on a text-only model deserves a clearer error than "not found"
	if (
		bestMatch(
			query,
			all.filter((m) => !hasImageInput(m)),
		)
	) {
		return cannotAcceptImages(input, vision);
	}

	// 4. No match — list the available vision models
	if (vision.length === 0) {
		return "No vision-capable model is available (none has image input or auth configured).";
	}
	return `Model not found: "${input}".\n\nAvailable vision models:\n${visionList(vision)}`;
}
