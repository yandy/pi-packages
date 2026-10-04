import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

// 测试侧的可观测通道：把 didOpen/didClose 计数同步写到客户端 root 下的文件，
// 替代曾随包发布的 LspClient.getCounts()（test/counts 专用请求）。
let rootDir = null;
let didOpenCount = 0;
let didCloseCount = 0;

function persistCounts() {
	if (!rootDir) return;
	writeFileSync(
		`${rootDir}/.lsp-counts.json`,
		JSON.stringify({ didOpen: didOpenCount, didClose: didCloseCount }),
	);
}

conn.onRequest("initialize", (p) => {
	rootDir = p?.rootUri ? fileURLToPath(p.rootUri) : null;
	return {
		capabilities: {
			hoverProvider: true,
			documentSymbolProvider: true,
			definitionProvider: true,
			referencesProvider: true,
		},
	};
});

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

conn.onNotification("initialized", () => {});
conn.onNotification("textDocument/didOpen", () => {
	didOpenCount++;
	persistCounts();
});
conn.onNotification("textDocument/didClose", () => {
	didCloseCount++;
	persistCounts();
});
conn.onNotification("exit", () => {
	conn.dispose();
	process.exit(0);
});

conn.listen();
