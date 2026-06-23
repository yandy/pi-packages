declare module "turndown" {
	interface TurndownOptions {
		headingStyle?: "setext" | "atx";
		hr?: string;
		bulletListMarker?: "-" | "+" | "*";
		codeBlockStyle?: "indented" | "fenced";
		fence?: "```" | "~~~";
		emDelimiter?: "_" | "*";
		strongDelimiter?: "__" | "**";
		linkStyle?: "inlined" | "referenced";
		linkReferenceStyle?: "full" | "collapsed" | "shortcut";
		preformattedCode?: boolean;
	}

	export default class TurndownService {
		constructor(options?: TurndownOptions);
		turndown(html: string | Node): string;
	}
}
