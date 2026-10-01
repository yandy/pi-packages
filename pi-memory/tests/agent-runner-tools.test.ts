import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SDK 语义钉子：`tools` 是**白名单**，会把 `customTools` 一起过滤。
 *
 * `createAgentSession` 里 `allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined)`，
 * 而 `agent-session` 的 `isAllowedTool` 同样作用于 customTools —— 因此 `tools: []` 会把 dream 的
 * `memory` 工具也滤掉：dream 一个原语都调不到却「成功」返回，extract 写不进任何记忆（Finding C1）。
 * 「关 builtin、只留 custom tools」唯一正确的写法是 `noTools: "builtin"`。
 *
 * 这里用**真实 SDK**（不 mock `createAgentSession`）按 agent-runner 的真实构造方式起 session，
 * 把这条语义钉死：SDK 未来若改掉它，本文件会红，重钉即可。全程离线（无 model / 无 auth）。
 */
const memoryTool = {
	name: "memory",
	label: "Memory",
	description: "pi-memory primitives",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: async () => ({ content: [] }),
} as unknown as ToolDefinition;

let home: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mem-tools-home-"));
	cwd = await mkdtemp(join(tmpdir(), "mem-tools-cwd-"));
	// getAgentDir() 必须落在临时目录（docs/guides/testing.md 的隔离要求）。
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

/** 与 `src/agent-runner.ts` 的构造逐项一致，只替换工具相关选项。 */
async function createSession(opts: { tools?: string[]; noTools?: "all" | "builtin" }) {
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	return createAgentSession({
		cwd,
		...opts,
		customTools: [memoryTool],
		model: undefined,
		// modelRegistry 无可用 provider 也能起 session（model 为 undefined，不触发任何网络）。
		modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] } as any,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		resourceLoader: loader,
	});
}

describe("createAgentSession tool filtering (real SDK)", () => {
	it("keeps custom tools active when noTools is 'builtin'", async () => {
		const created = await createSession({ noTools: "builtin" });
		try {
			expect(created.session.getActiveToolNames()).toContain("memory");
		} finally {
			created.session.dispose?.();
		}
	});

	it("filters custom tools out when tools: [] is passed (the trap dream/extract must not fall into)", async () => {
		const created = await createSession({ tools: [] });
		try {
			expect(created.session.getActiveToolNames()).not.toContain("memory");
		} finally {
			created.session.dispose?.();
		}
	});
});
