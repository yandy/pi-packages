import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc";

const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

conn.onRequest("initialize", () => ({
	capabilities: {
		hoverProvider: true,
		documentSymbolProvider: true,
		definitionProvider: true,
		referencesProvider: true,
	},
}));

conn.onRequest("textDocument/documentSymbol", () => [
	{
		name: "UserService",
		kind: 5, // Class
		range: { start: { line: 0, column: 0 }, end: { line: 9, column: 0 } },
		selectionRange: { start: { line: 0, column: 6 }, end: { line: 0, column: 16 } },
		children: [
			{
				name: "findById",
				kind: 6, // Method
				detail: "findById(id: string): User",
				range: { start: { line: 1, column: 2 }, end: { line: 3, column: 2 } },
				selectionRange: { start: { line: 1, column: 2 }, end: { line: 1, column: 10 } },
			},
		],
	},
]);

conn.onRequest("textDocument/hover", () => ({
	contents: { kind: "markdown", value: "`(method) UserService.findById(id: string): User`" },
}));

conn.onRequest("textDocument/definition", (p) => [
	{ uri: p.textDocument.uri, range: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } } },
]);

conn.onRequest("textDocument/references", (p) => [
	{ uri: p.textDocument.uri, range: { start: { line: 2, column: 4 }, end: { line: 2, column: 12 } } },
	{ uri: p.textDocument.uri, range: { start: { line: 7, column: 0 }, end: { line: 7, column: 8 } } },
]);

conn.onRequest("shutdown", () => null);
conn.onRequest("test/counts", () => ({ didOpen: didOpenCount, didClose: didCloseCount }));

let didOpenCount = 0;
let didCloseCount = 0;

conn.onNotification("initialized", () => {});
conn.onNotification("textDocument/didOpen", () => {
	didOpenCount++;
});
conn.onNotification("textDocument/didClose", () => {
	didCloseCount++;
});
conn.onNotification("exit", () => {
	conn.dispose();
	process.exit(0);
});

conn.listen();
