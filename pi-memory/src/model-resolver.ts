import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact "provider/modelId" match (only available models), then fuzzy match.
 * Returns the Model on success, or undefined on failure (caller falls back to parent model).
 */
export function resolveModel(input: string, registry: ModelRegistry): Model<any> | undefined {
	if (!input) return undefined;
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	if (all.length === 0) return undefined;
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// 2. Fuzzy match against available models
	const query = input.toLowerCase();
	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const m of all) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (
			query
				.split(/[\s\-/]+/)
				.every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
		) {
			score = 20;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) return found;
	}

	return undefined;
}
