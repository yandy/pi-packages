import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Resolve a "provider/modelId" or fuzzy name string to a Model instance.
 *
 * - Exact match: "provider/modelId" — calls registry.find(provider, modelId),
 *   returns model only if it's in the available set.
 * - Fuzzy match: no slash or exact match failed — searches available models
 *   by id/name substring, picks best score ≥20. Returns undefined if none qualify.
 */
export function resolveModel(modelStr: string, registry: ModelRegistry): Model<any> | undefined {
  const available = registry.getAvailable?.() ?? [];

  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    const found = registry.find(provider, modelId);
    if (found) {
      const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
      if (availableKeys.has(`${provider}/${modelId}`)) return found as Model<any>;
    }
  }

  // Fuzzy match
  const query = modelStr.toLowerCase();
  interface Scored { model: { provider: string; id: string }; score: number }
  const scored: Scored[] = [];
  for (const m of available) {
    const key = `${m.provider}/${m.id}`.toLowerCase();
    let score = 0;
    if (key === query) score = 100;
    else if (key.includes(query)) score = 80 + query.length;
    else if (query.includes(key)) score = 50;
    else {
      // Partial word match
      const words = query.split(/[\s/_-]+/);
      for (const w of words) {
        if (w.length >= 2 && (m.id.toLowerCase().includes(w) || m.provider.toLowerCase().includes(w))) {
          score += Math.max(10, w.length * 5);
        }
      }
    }
    if (score >= 20) scored.push({ model: m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;

  const best = scored[0].model;
  const found = registry.find(best.provider, best.id);
  return (found as Model<any>) ?? undefined;
}
