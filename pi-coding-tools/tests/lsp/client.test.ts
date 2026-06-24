import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspClient } from "../../src/lsp/client";
import type { ServerDef } from "../../src/lsp/servers";

const fakeServerPath = join(import.meta.dirname, "fixtures/fake-lsp-server.mjs");
const fakeServer: ServerDef = {
	id: "fake",
	command: ["node", fakeServerPath],
	extensions: [".ts"],
	languageId: "typescript",
	installHint: "fake",
};

let root: string;
let client: LspClient;
let sampleFile: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "lsp-client-"));
	sampleFile = join(root, "sample.ts");
	writeFileSync(
		sampleFile,
		"class UserService {\n  findById(id) { return null; }\n}\nconst u = new UserService();\nu.findById('1');\n",
	);
	client = new LspClient(root, fakeServer);
	await client.start();
	await client.initialize();
});

afterAll(async () => {
	await client.stop();
});

describe("LspClient end-to-end (fake server)", () => {
	it("documentSymbols returns tree", async () => {
		const syms = await client.documentSymbols(sampleFile);
		expect(syms.length).toBeGreaterThan(0);
		const cls = syms.find((s) => "name" in s && s.name === "UserService");
		expect(cls).toBeDefined();
		expect(cls && "children" in cls && cls.children?.length).toBe(1);
	});

	it("hover returns contents", async () => {
		const h = await client.hover(sampleFile, 2, 6);
		expect(h).not.toBeNull();
	});

	it("definition returns location", async () => {
		const def = await client.definition(sampleFile, 4, 2);
		expect(def).not.toBeNull();
	});

	it("references returns array", async () => {
		const refs = await client.references(sampleFile, 2, 6);
		expect(Array.isArray(refs) ? refs.length : 0).toBeGreaterThan(0);
	});

	it("isAlive true after start", () => {
		expect(client.isAlive()).toBe(true);
	});
});
