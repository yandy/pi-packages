declare module "@mixmark-io/domino" {
	interface DomNode {
		nodeType: number;
		nodeName: string;
		textContent: string | null;
		parentNode: DomNode | null;
		removeChild(child: DomNode): DomNode;
	}

	interface DomDocument extends DomNode {
		title: string;
		body: DomNode | null;
		documentElement: DomNode;
		querySelector(selectors: string): DomNode | null;
		querySelectorAll(selectors: string): ArrayLike<DomNode>;
	}

	export function createDocument(html?: string, force?: boolean): DomDocument;
}
