import type { CodingToolsConfig } from "../config";
import { LspClient } from "./client";
import { resolveServerForFile, type ServerDef } from "./servers";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REAPER_INTERVAL_MS = 60_000;

interface Managed {
	client: LspClient;
	server: ServerDef;
	lastUsedAt: number;
}

export interface LspManagerOptions {
	idleTimeoutMs?: number;
	reaperIntervalMs?: number;
	now?: () => number;
	clientFactory?: (root: string, server: ServerDef) => LspClient;
}

export class LspManager {
	private readonly clients = new Map<string, Managed>(); // languageId → managed
	private reaper: NodeJS.Timeout | null = null;
	private disposed = false;
	private readonly idleTimeoutMs: number;
	private readonly reaperIntervalMs: number;
	private readonly now: () => number;
	private readonly clientFactory: (root: string, server: ServerDef) => LspClient;

	constructor(opts: LspManagerOptions = {}) {
		this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.reaperIntervalMs = opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
		this.now = opts.now ?? (() => Date.now());
		this.clientFactory = opts.clientFactory ?? ((root, server) => new LspClient(root, server));
		this.startReaper();
	}

	private startReaper(): void {
		this.reaper = setInterval(() => this.reapStale(), this.reaperIntervalMs);
		this.reaper.unref?.();
	}

	private reapStale(): void {
		const t = this.now();
		for (const [lang, m] of this.clients) {
			if (t - m.lastUsedAt > this.idleTimeoutMs) {
				m.client.stop().catch(() => {});
				this.clients.delete(lang);
			}
		}
	}

	async getClientForFile(
		path: string,
		root: string,
		config?: CodingToolsConfig,
	): Promise<{ client: LspClient; server: ServerDef }> {
		if (this.disposed) throw new Error("LspManager disposed");
		const resolved = resolveServerForFile(path, config);
		if (!resolved) throw new Error(`No LSP server for ${path}`);
		const { server, installed } = resolved;
		if (!installed) {
			throw new Error(`LSP server '${server.id}' not installed. Install: ${server.installHint}`);
		}

		const lang = server.languageId;
		let m = this.clients.get(lang);
		if (m && !m.client.isAlive()) {
			// 崩溃：驱逐，下方重建（重启一次）
			await m.client.stop().catch(() => {});
			this.clients.delete(lang);
			m = undefined;
		}
		if (!m) {
			const client = this.clientFactory(root, server);
			await client.start();
			await client.initialize();
			m = { client, server, lastUsedAt: this.now() };
			this.clients.set(lang, m);
		}
		m.lastUsedAt = this.now();
		return { client: m.client, server: m.server };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = null;
		}
		const stops = [...this.clients.values()].map((m) => m.client.stop().catch(() => {}));
		this.clients.clear();
		await Promise.allSettled(stops);
	}
}
