export interface QuestionOption {
	title: string;
	description?: string;
}

export interface AnnotatedRow {
	line: string;
	selected: boolean;
}

export interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	allowFreeform: boolean;
	allowComment?: boolean;
	commentEnabled?: boolean;
	maxRows?: number;
	hideDescriptions?: boolean;
}

function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	if (width <= 1) return normalized.split("");

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			if (word.length <= width) {
				current = word;
			} else {
				for (let i = 0; i < word.length; i += width) {
					lines.push(word.slice(i, i + width));
				}
			}
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		if (word.length <= width) {
			current = word;
		} else {
			current = "";
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				if (chunk.length === width || i + width < word.length) lines.push(chunk);
				else current = chunk;
			}
		}
	}

	if (current) lines.push(current);
	return lines;
}

function padLine(prefix: string, content: string): string {
	return `${prefix}${content}`.trimEnd();
}
interface ItemBlock {
	itemIndex: number;
	lines: string[];
}

type ListItem =
	| { type: "option"; option: QuestionOption }
	| { type: "comment-toggle"; option: QuestionOption }
	| { type: "freeform"; option: QuestionOption };

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	allowFreeform: boolean,
	allowComment: boolean,
	commentEnabled: boolean,
	selectedIndex: number,
	hideDescriptions = false,
): ItemBlock[] {
	const normalizedWidth = Math.max(12, width);
	const freeformLabel = "Type something. — Enter a custom response";
	const commentToggleLabel = `${commentEnabled ? "[✓]" : "[ ]"} Add extra context after selection`;
	const allItems: ListItem[] = options.map((option) => ({ type: "option", option }));
	if (allowComment) {
		allItems.push({ type: "comment-toggle", option: { title: commentToggleLabel } });
	}
	if (allowFreeform) {
		allItems.push({ type: "freeform", option: { title: freeformLabel } });
	}

	return allItems.map((item, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "→" : " ";
		const lines: string[] = [];

		if (item.type === "comment-toggle" || item.type === "freeform") {
			const prefix = `${pointer}   `;
			const wrapped = wrapText(item.option.title, Math.max(8, normalizedWidth - prefix.length));
			wrapped.forEach((line, lineIndex) => {
				lines.push(padLine(lineIndex === 0 ? prefix : " ".repeat(prefix.length), line));
			});
			return { itemIndex, lines };
		}

		const numberPrefix = `${pointer} ${itemIndex + 1}. `;
		const continuationPrefix = " ".repeat(numberPrefix.length);
		const titleLines = wrapText(item.option.title, Math.max(8, normalizedWidth - numberPrefix.length));
		titleLines.forEach((line, lineIndex) => {
			lines.push(padLine(lineIndex === 0 ? numberPrefix : continuationPrefix, line));
		});

		if (item.option.description && !hideDescriptions) {
			const descriptionPrefix = "      ";
			const descriptionLines = wrapText(item.option.description, Math.max(8, normalizedWidth - descriptionPrefix.length));
			descriptionLines.forEach((line) => {
				lines.push(padLine(descriptionPrefix, line));
			});
		}

		return { itemIndex, lines };
	});
}

export interface SelectableBlock {
	lines: string[];
	selected: boolean;
}

export interface WindowSelectedBlocksParams {
	blocks: SelectableBlock[];
	maxRows: number;
	indicator: string;
}

/**
 * Window pre-rendered blocks around the selected one so the total row count
 * stays within `maxRows`. When everything fits, all rows are returned as-is;
 * otherwise the selected block is kept visible, neighbouring blocks fill the
 * remaining space, and a single indicator row (e.g. "  (3/12)") is appended.
 */
export function windowSelectedBlocks({ blocks, maxRows, indicator }: WindowSelectedBlocksParams): AnnotatedRow[] {
	const totalRows = blocks.reduce((count, block) => count + block.lines.length, 0);
	if (!Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || totalRows <= maxRows) {
		return blocks.flatMap((block) => block.lines.map((line) => ({ line, selected: block.selected })));
	}

	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const selectedIndex = Math.max(
		blocks.findIndex((block) => block.selected),
		0,
	);
	const selectedBlock = blocks[selectedIndex];
	if (!selectedBlock) return [];

	const availableRows = safeMaxRows > 1 ? safeMaxRows - 1 : 1;

	if (selectedBlock.lines.length >= availableRows) {
		const visible = selectedBlock.lines.slice(0, availableRows).map((line) => ({
			line,
			selected: true,
		}));
		if (safeMaxRows > 1) visible.push({ line: indicator, selected: false });
		return visible.slice(0, safeMaxRows);
	}

	let start = selectedIndex;
	let end = start + 1;
	let usedRows = selectedBlock.lines.length;

	while (true) {
		const nextCanFit = end < blocks.length && usedRows + blocks[end]?.lines.length <= availableRows;
		if (nextCanFit) {
			usedRows += blocks[end]?.lines.length;
			end += 1;
			continue;
		}

		const prevCanFit = start > 0 && usedRows + blocks[start - 1]?.lines.length <= availableRows;
		if (prevCanFit) {
			start -= 1;
			usedRows += blocks[start]?.lines.length;
			continue;
		}

		break;
	}

	const visible = blocks
		.slice(start, end)
		.flatMap((block) => block.lines.map((line) => ({ line, selected: block.selected })));
	visible.push({ line: indicator, selected: false });
	return visible.slice(0, safeMaxRows);
}

export function renderSingleSelectRows({
	options,
	selectedIndex,
	width,
	allowFreeform,
	allowComment = false,
	commentEnabled = false,
	maxRows,
	hideDescriptions,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
	const itemCount = options.length + (allowComment ? 1 : 0) + (allowFreeform ? 1 : 0);
	const blocks = buildItemBlocks(
		options,
		width,
		allowFreeform,
		allowComment,
		commentEnabled,
		selectedIndex,
		hideDescriptions,
	);

	return windowSelectedBlocks({
		blocks: blocks.map((block) => ({ lines: block.lines, selected: block.itemIndex === selectedIndex })),
		maxRows: maxRows ?? Number.POSITIVE_INFINITY,
		indicator: `  (${selectedIndex + 1}/${itemCount})`,
	});
}
