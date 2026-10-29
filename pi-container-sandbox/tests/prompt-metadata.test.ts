import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import register from "../index";

/**
 * 提示词元数据回归闸（spec 2026-10-30 §7-1）。
 *
 * 背景：本包曾用 `create*Tool()`（返回 AgentTool）作 base 再 spread 注册。宿主
 * `wrapToolDefinition()` 只透传 name/label/description/parameters/prepareArguments/executionMode，
 * **不透传 promptSnippet / promptGuidelines**；覆盖内置工具后宿主只从覆盖后的定义读提示词元数据，
 * 不会回落到内置定义。后果：read/write/edit/bash 从 system prompt 的 "Available tools" 整体消失，
 * 内置 edit 的 4 条纪律（约 496 字符）与 read/write 各 1 条一并被吞掉（合计 779 字符）。
 *
 * 本测试捕获 `registerTool` 收到的定义，钉住这三件事：目录行在、纪律在、schema 选项未丢。
 */

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
}

function captureTools(): CapturedTool[] {
	const tools: CapturedTool[] = [];
	const noop = () => {};
	// 最小 ExtensionAPI stub：扩展装配期只用到这几个成员（registerFlag/on/registerCommand 是副作用）。
	const stub = {
		registerTool: (definition: CapturedTool) => {
			tools.push(definition);
		},
		registerFlag: noop,
		registerCommand: noop,
		on: noop,
		getFlag: () => undefined,
		getActiveTools: () => [],
		setActiveTools: noop,
		events: { emit: noop },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	register(stub as unknown as ExtensionAPI);
	return tools;
}

describe("注册的 read/write/edit/bash 保留提示词元数据（spec 2026-10-30 §7-1）", () => {
	const tools = captureTools();
	const byName = new Map(tools.map((t) => [t.name, t]));

	it("注册了四个被覆盖的内置工具", () => {
		expect([...byName.keys()].sort()).toEqual(["bash", "edit", "read", "write"]);
	});

	it("每个工具都有 promptSnippet（否则会从 Available tools 消失）", () => {
		for (const name of ["read", "write", "edit", "bash"]) {
			const tool = byName.get(name);
			expect(tool?.promptSnippet, `${name} 缺 promptSnippet`).toBeTruthy();
			expect(tool?.promptSnippet?.length ?? 0).toBeGreaterThan(0);
		}
		expect(byName.get("read")?.promptSnippet).toBe("Read file contents");
		expect(byName.get("bash")?.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
	});

	it("保留内置 guideline（read/write/edit 各自的行为纪律）", () => {
		expect(byName.get("read")?.promptGuidelines).toContain("Use read to examine files instead of cat or sed.");
		expect(byName.get("write")?.promptGuidelines).toContain("Use write only for new files or complete rewrites.");
		const editGuidelines = byName.get("edit")?.promptGuidelines ?? [];
		expect(editGuidelines.length).toBeGreaterThanOrEqual(4);
		expect(editGuidelines[0]).toContain("Use edit for precise changes");
		expect(editGuidelines.join("\n")).toContain("Do not emit overlapping or nested edits");
	});

	it("保留 base schema 选项（edit 的 additionalProperties:false 不能因重建对象而丢）", () => {
		expect(byName.get("edit")?.parameters.additionalProperties).toBe(false);
		expect(byName.get("edit")?.parameters.properties).toHaveProperty("edits");
	});

	it("description 仍是内置描述（本包不额外追加提示词）", () => {
		expect(byName.get("read")?.description).toContain("Read the contents of a file");
		expect(byName.get("bash")?.description).toContain("Execute a bash command");
	});

	it("三通道合计不超预算（spec 2026-10-30 §10）", () => {
		// 修补前为 2579（snippet/guidelines 全丢），修补后回收 779 字符 → 约 3358。
		assertPromptHygiene({ pkg: "pi-container-sandbox", budget: 3500, tools, authored: [] });
	});
});
