import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { ServerDef } from "./servers";
import type { DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "./types";

const POST_OPEN_DELAY_MS = 200;

export class LspClient {
	private conn: MessageConnection | null = null;
	private proc: import("node:child_process").ChildProcess | null = null;
	private readonly openedFiles = new Set<string>();
	private readonly documentVersions = new Map<string, number>();
	private readonly lastMtime = new Map<string, number>();
	private alive = false;

	constructor(
		private readonly root: string,
		private readonly server: ServerDef,
	) {}

	command(): string[] {
		return this.server.command;
	}

	isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		const [cmd, ...args] = this.server.command;
		const proc = spawn(cmd, args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;
		this.alive = true;
		proc.once("exit", () => {
			this.alive = false;
		});
		this.conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
		this.conn.listen();
	}

	async initialize(): Promise<void> {
		if (!this.conn) throw new Error("not started");
		await this.conn.sendRequest("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(this.root).href,
			capabilities: {
				textDocument: {
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					hover: { contentFormat: ["markdown", "plaintext"] },
					definition: { linkSupport: true },
				},
			},
			workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
			initializationOptions: this.server.initOptions ?? {},
		});
		await this.conn.sendNotification("initialized", {});
	}

	private async sendRequest<R>(method: string, params: unknown): Promise<R> {
		if (!this.conn) throw new Error("not started");
		return this.conn.sendRequest(method, params);
	}

	private async sendNotification(method: string, params: unknown): Promise<void> {
		if (!this.conn) throw new Error("not started");
		await this.conn.sendNotification(method, params);
	}

	async openFile(filePath: string): Promise<void> {
		const absPath = resolve(filePath);
		const uri = pathToFileURL(absPath).href;

		const mtime = statSync(absPath).mtimeMs;
		if (this.openedFiles.has(absPath)) {
			// mtime unchanged → skip (no disk read)
			if (this.lastMtime.get(uri) === mtime) return;
			// mtime changed → close to re-open below (captures external edits)
			await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
			this.openedFiles.delete(absPath);
		}

		const text = readFileSync(absPath, "utf-8");
		const version = (this.documentVersions.get(uri) ?? 0) + 1;
		this.documentVersions.set(uri, version);
		this.lastMtime.set(uri, mtime);
		await this.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId: this.server.languageId, version, text },
		});
		this.openedFiles.add(absPath);
		await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
	}

	async hover(filePath: string, line: number, character: number): Promise<Hover> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Hover>("textDocument/hover", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
		});
	}

	async documentSymbols(filePath: string): Promise<Array<DocumentSymbol | SymbolInformation>> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Array<DocumentSymbol | SymbolInformation>>("textDocument/documentSymbol", {
			textDocument: { uri: pathToFileURL(absPath).href },
		});
	}

	async definition(
		filePath: string,
		line: number,
		character: number,
	): Promise<Location | LocationLink | Array<Location | LocationLink> | null> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest("textDocument/definition", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
		});
	}

	async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Location[]>("textDocument/references", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
			context: { includeDeclaration },
		});
	}

	async getCounts(): Promise<{ didOpen: number; didClose: number }> {
		return this.sendRequest<{ didOpen: number; didClose: number }>("test/counts", {});
	}

	async stop(): Promise<void> {
		this.alive = false;
		try {
			if (this.conn) {
				await this.conn.sendRequest("shutdown", null).catch(() => {});
				await this.conn.sendNotification("exit", null).catch(() => {});
				this.conn.dispose();
			}
		} catch {}
		this.conn = null;
		if (this.proc) {
			this.proc.stdin?.destroy();
			this.proc.kill("SIGKILL");
			this.proc = null;
		}
	}
}
