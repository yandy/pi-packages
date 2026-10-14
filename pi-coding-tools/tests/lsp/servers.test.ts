import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SERVERS, detectLanguage, resolveServerForFile } from "../../src/lsp/servers";

/** 造一个 typescript 包（省略 version 则不造）；entry=false 时不给 lib/tsc.js */
function writeTypescript(dir: string, version?: string, entry = true): void {
	if (version === undefined) return;
	const pkgDir = join(dir, "node_modules", "typescript");
	mkdirSync(join(pkgDir, "lib"), { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript", version }));
	if (entry) writeFileSync(join(pkgDir, "lib", "tsc.js"), "");
}

function writeProject(dir: string): string {
	const project = join(dir, "packages", "app");
	mkdirSync(project, { recursive: true });
	return project;
}

describe("servers", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "coding-tools-servers-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("detects language by extension", () => {
		expect(detectLanguage("src/a.ts")).toBe("typescript");
		expect(detectLanguage("a.py")).toBe("python");
		expect(detectLanguage("a.java")).toBe("java");
		expect(detectLanguage("a.kt")).toBe("kotlin");
		expect(detectLanguage("a.cpp")).toBe("cpp");
		expect(detectLanguage("a.md")).toBeUndefined();
	});

	it("prefers the native tsc LSP when the nearest TypeScript is >= 7", () => {
		writeTypescript(root, "7.0.2");
		const r = resolveServerForFile("src/a.ts", root);
		expect(r?.server.id).toBe("tsc");
		expect(r?.server.command).toEqual([
			"node",
			join(root, "node_modules", "typescript", "lib", "tsc.js"),
			"--lsp",
			"--stdio",
		]);
		expect(r?.installed).toBe(true);
	});

	it("finds the native LSP by walking up from the session directory", () => {
		writeTypescript(root, "7.0.2");
		expect(resolveServerForFile("src/a.ts", writeProject(root))?.server.id).toBe("tsc");
	});

	it("falls back to typescript-language-server for TypeScript < 7", () => {
		writeTypescript(root, "6.0.3");
		expect(resolveServerForFile("src/a.ts", root)?.server.id).toBe("typescript-language-server");
	});

	it("does not use an ancestor TypeScript when the nearest one is < 7", () => {
		writeTypescript(root, "7.0.2");
		writeTypescript(writeProject(root), "6.0.3");
		expect(resolveServerForFile("src/a.ts", writeProject(root))?.server.id).toBe("typescript-language-server");
	});

	it("falls back when the workspace has no TypeScript at all", () => {
		expect(resolveServerForFile("src/a.ts", root)?.server.id).toBe("typescript-language-server");
	});

	it("falls back when the TypeScript 7 package has no tsc.js entry point", () => {
		writeTypescript(root, "7.0.2", false);
		expect(resolveServerForFile("src/a.ts", root)?.server.id).toBe("typescript-language-server");
	});

	it("honours lsp.servers.tsc.disabled to force the fallback server", () => {
		writeTypescript(root, "7.0.2");
		const r = resolveServerForFile("src/a.ts", root, { lsp: { servers: { tsc: { disabled: true } } } });
		expect(r?.server.id).toBe("typescript-language-server");
	});

	it("honours a command override on the native server", () => {
		writeTypescript(root, "7.0.2");
		const command = ["node", "/custom/tsc.js", "--lsp", "--stdio"];
		const r = resolveServerForFile("src/a.ts", root, { lsp: { servers: { tsc: { command } } } });
		expect(r?.server.id).toBe("tsc");
		expect(r?.server.command).toEqual(command);
	});

	it("resolves server for .py", () => {
		expect(resolveServerForFile("a.py", root)?.server.id).toBe("pyright");
	});

	it("returns null for unsupported extension", () => {
		expect(resolveServerForFile("a.md", root)).toBeNull();
	});

	it("respects config lsp.servers override disabled", () => {
		const r = resolveServerForFile("a.cpp", root, { lsp: { servers: { clangd: { disabled: true } } } });
		expect(r).toBeNull();
	});

	it("respects config lsp.disabled (whole lsp off)", () => {
		expect(resolveServerForFile("a.ts", root, { lsp: { disabled: true } })).toBeNull();
	});

	it("builtin servers cover all P0 langs", () => {
		const ids = BUILTIN_SERVERS.map((s) => s.id);
		expect(ids).toContain("tsc");
		expect(ids).toContain("typescript-language-server");
		expect(ids).toContain("pyright");
		expect(ids).toContain("jdtls");
		expect(ids).toContain("kotlin-language-server");
		expect(ids).toContain("clangd");
	});
});
