export interface TopicMeta {
	name: string;
	description: string;
	type: string;
	updated: string;
}

export function buildFrontmatter(meta: TopicMeta): string {
	return `---
name: ${meta.name}
description: ${meta.description}
type: ${meta.type}
updated: ${meta.updated}
---

`;
}

export function appendContent(existing: string | null, heading: string, content: string): string {
	const section = `## ${heading}\n\n${content}`;
	if (!existing || existing.trim() === "") return `# ${heading}\n\n${content}`;
	return `${existing.trimEnd()}\n\n${section}\n`;
}

export function isEmptyAfterRemove(content: string): boolean {
	return content.trim() === "";
}
