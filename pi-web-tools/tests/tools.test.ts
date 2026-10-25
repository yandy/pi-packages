import { describe, expect, it } from "vitest";
import extension from "../index.js";

interface ToolDef {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: {
		properties?: Record<string, { enum?: string[]; anyOf?: Array<{ enum?: string[] }> }>;
	};
}

function captureTools(): ToolDef[] {
	const tools: ToolDef[] = [];
	const pi = {
		registerTool: (def: ToolDef) => {
			tools.push(def);
		},
	};
	extension(pi as never);
	return tools;
}

function providerEnum(tool: ToolDef): string[] {
	const schema = tool.parameters.properties?.provider;
	if (!schema) return [];
	if (schema.enum) return schema.enum;
	const branch = schema.anyOf?.find((s) => Array.isArray(s.enum));
	return branch?.enum ?? [];
}

function formatEnum(tool: ToolDef): string[] {
	const schema = tool.parameters.properties?.format;
	if (!schema) return [];
	if (schema.enum) return schema.enum;
	const branch = schema.anyOf?.find((s) => Array.isArray(s.enum));
	return branch?.enum ?? [];
}

describe("tool registration", () => {
	it("websearch advertises the full three-provider chain to the model", () => {
		const websearch = captureTools().find((t) => t.name === "websearch");
		expect(websearch).toBeDefined();
		expect(websearch?.description).toContain("DeepSeek");
		expect(websearch?.promptSnippet).toContain("DeepSeek");
	});

	it("websearch accepts every documented provider", () => {
		const websearch = captureTools().find((t) => t.name === "websearch");
		expect(providerEnum(websearch as ToolDef)).toEqual(["exa", "deepseek", "aliyun"]);
	});

	it("webfetch accepts every documented provider", () => {
		const webfetch = captureTools().find((t) => t.name === "webfetch");
		expect(webfetch).toBeDefined();
		expect(providerEnum(webfetch as ToolDef)).toEqual(["local", "deepseek"]);
	});

	it("webfetch exposes only the markdown and origin output formats", () => {
		const webfetch = captureTools().find((t) => t.name === "webfetch");
		expect(formatEnum(webfetch as ToolDef)).toEqual(["markdown", "origin"]);
	});

	it("webfetch description tells the model origin means untouched raw body", () => {
		const webfetch = captureTools().find((t) => t.name === "webfetch");
		expect(webfetch?.description).toContain("origin");
		expect(webfetch?.description?.toLowerCase()).toContain("raw");
	});
});
