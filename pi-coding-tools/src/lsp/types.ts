export interface Position {
	line: number; // 0-based
	character: number; // 0-based
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange?: Range;
}

export type SymbolKind = number;

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	location: Location;
	containerName?: string;
}

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export type Hover = {
	contents: MarkupContent | string | Array<MarkupContent | string>;
	range?: Range;
} | null;

// SymbolKind 常用枚举值（LSP 规范）
const SYMBOL_KIND: Record<string, number> = {
	File: 1,
	Module: 2,
	Namespace: 3,
	Package: 4,
	Class: 5,
	Method: 6,
	Property: 7,
	Field: 8,
	Constructor: 9,
	Enum: 10,
	Interface: 11,
	Function: 12,
	Variable: 13,
	Constant: 14,
	Struct: 23,
	Event: 24,
	Operator: 25,
	TypeParameter: 26,
};

export function symbolKindName(kind: number): string {
	const entry = Object.entries(SYMBOL_KIND).find(([, v]) => v === kind);
	return entry ? entry[0] : "Symbol";
}
