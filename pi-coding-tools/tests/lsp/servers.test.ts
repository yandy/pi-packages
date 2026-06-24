import { describe, expect, it } from "vitest";
import { BUILTIN_SERVERS, detectLanguage, resolveServerForFile } from "../../src/lsp/servers";

describe("servers", () => {
	it("detects language by extension", () => {
		expect(detectLanguage("src/a.ts")).toBe("typescript");
		expect(detectLanguage("a.py")).toBe("python");
		expect(detectLanguage("a.java")).toBe("java");
		expect(detectLanguage("a.kt")).toBe("kotlin");
		expect(detectLanguage("a.cpp")).toBe("cpp");
		expect(detectLanguage("a.md")).toBeUndefined();
	});

	it("resolves server for .ts", () => {
		const r = resolveServerForFile("src/a.ts");
		expect(r?.server.id).toBe("typescript-language-server");
	});

	it("resolves server for .py", () => {
		expect(resolveServerForFile("a.py")?.server.id).toBe("pyright");
	});

	it("returns null for unsupported extension", () => {
		expect(resolveServerForFile("a.md")).toBeNull();
	});

	it("respects config lsp.servers override disabled", () => {
		const r = resolveServerForFile("a.cpp", { lsp: { servers: { clangd: { disabled: true } } } });
		expect(r).toBeNull();
	});

	it("respects config lsp.disabled (whole lsp off)", () => {
		const r = resolveServerForFile("a.ts", { lsp: { disabled: true } });
		expect(r).toBeNull();
	});

	it("builtin servers cover all P0 langs", () => {
		const ids = BUILTIN_SERVERS.map((s) => s.id);
		expect(ids).toContain("typescript-language-server");
		expect(ids).toContain("pyright");
		expect(ids).toContain("jdtls");
		expect(ids).toContain("kotlin-language-server");
		expect(ids).toContain("clangd");
	});
});
