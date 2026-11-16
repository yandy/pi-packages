import { describe, expect, it } from "vitest";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assertPromptHygiene } from "../../scripts/prompt-hygiene";
import register from "../index";

/**
 * 提示词元数据回归闸（spec 2026-10-30 §7-1）。
 *
 * 背景：本包曾用 `create*Tool()`（返回 AgentTool）作 base 再 spread 注册。宿主
 * `wrapToolDefinition()` 只透传 name/label/description/parameters/prepareArguments/executionMode，
 * **不透传 promptSnippet / promptGuidelines**；覆盖内置工具后宿主只从覆盖后的定义读提示词元数据，
 * 不会回落到内置定义。后果：read/write/edit/bash 从 system prompt 的 "Available tools" 整体消失，
 * 内置 edit 的全部纪律与 read/write 各自的纪律一并被吞掉——条数与字符数随宿主 dist 漂移，此处不钉具体值。
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

/** 宿主 base 定义的 guideline：断言一律与它对照，不写死宿主的条数或文案（宿主版本会漂移）。 */
function baseGuidelines(name: "read" | "write" | "edit"): string[] {
	const cwd = process.cwd();
	if (name === "read") return createReadToolDefinition(cwd).promptGuidelines ?? [];
	if (name === "write") return createWriteToolDefinition(cwd).promptGuidelines ?? [];
	return createEditToolDefinition(cwd).promptGuidelines ?? [];
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
		// 钉包内性质：`...localRead` 这类对象 spread 必须把 base 定义的每条 guideline 原样带上。
		// 不钉宿主的条数与文案——它们随宿主版本漂移（宿主的 edit 纪律条数与措辞都被改过）。
		for (const name of ["read", "write", "edit"] as const) {
			const registeredGuidelines = byName.get(name)?.promptGuidelines ?? [];
			const base = baseGuidelines(name);
			expect(base.length, `${name} 的 base 定义没有 guideline`).toBeGreaterThan(0);
			for (const guideline of base) {
				expect(registeredGuidelines, `${name} 丢了 base guideline：${guideline}`).toContain(guideline);
			}
		}
		expect(byName.get("read")?.promptGuidelines).toContain("Use read to examine files instead of cat or sed.");
		expect(byName.get("write")?.promptGuidelines).toContain("Use write only for new files or complete rewrites.");
	});

	it("保留 base schema 选项（不因重建对象而丢）", () => {
		const registered = byName.get("edit");
		const base = createEditToolDefinition(process.cwd());
		// 钉包内性质：宿主 schema 会漂移（`edit` 的 `additionalProperties` 在不同宿主版本间变过），
		// 故这里只断言「与 base 同值」，不钉具体取值——`...localEdit` 是对象 spread，包装后的它必然带上 base 的顶层 option。
		expect((registered?.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(
			(base.parameters as { additionalProperties?: boolean }).additionalProperties,
		);
		expect(registered?.parameters.properties).toHaveProperty("edits");
		// 上一条在「base 本就没有这个 option」的宿主上恒真，故再钉一条关系约束：顶层 schema options
		// 键集合与 base 逐字一致。它只在两种情形下鉴别得出问题：① 手写 `{ type, properties }` 重建会丢
		// `required` 键；② base 自带 `additionalProperties` 一类自有 option 的宿主版本。对 TypeBox 式
		// 重建（`Type.Object({ ...base.properties })`）它无鉴别力——当前宿主上重建出的顶层键、`required`、
		// `additionalProperties` 三项与 base 全同。
		expect(Object.keys(registered?.parameters ?? {}).sort()).toEqual(Object.keys(base.parameters).sort());
	});

	it("description 仍是内置描述（本包不额外追加提示词）", () => {
		expect(byName.get("read")?.description).toContain("Read the contents of a file");
		expect(byName.get("bash")?.description).toContain("Execute a bash command");
	});

	it("三通道合计不超预算（spec 2026-10-30 §10）", () => {
		// 提示词预算回归闸：元数据整体丢失会让三通道合计显著掉字符数，反之超出预算则说明提示词膨胀。
		// budget 是本包的策略值；三通道实际字符数随宿主 dist 漂移，故不在此写死任何一次实测值。
		assertPromptHygiene({ pkg: "pi-container-sandbox", budget: 3500, tools, authored: [] });
	});
});
