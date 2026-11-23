import { t } from "../i18n";
import type { CategoryId, Lang } from "../model";

export const CATEGORY_LABEL_KEY: Record<CategoryId, string> = {
	systemBase: "cat.systemBase",
	systemTools: "cat.systemTools",
	systemProject: "cat.systemProject",
	systemSkills: "cat.systemSkills",
	systemDocs: "cat.systemDocs",
	systemOther: "cat.systemOther",
	toolDefinitions: "cat.toolDefinitions",
	user: "cat.user",
	injected: "cat.injected",
	skillInjections: "cat.skillInjections",
	compaction: "cat.compaction",
	reasoning: "cat.reasoning",
	answers: "cat.answers",
	toolCalls: "cat.toolCalls",
	toolResults: "cat.toolResults",
	unattributed: "cat.unattributed",
};

export function categoryLabel(lang: Lang, id: CategoryId): string {
	return t(lang, { key: CATEGORY_LABEL_KEY[id] });
}
