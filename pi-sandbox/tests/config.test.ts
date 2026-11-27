import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, getSandboxConfig, loadSandboxConfig, resetSandboxConfigCache, validateSandboxConfig } from "../src/config";
import { resetConfigWarningStateForTests, setConfigWarningSink, takeConfigWarnings } from "../src/config-warnings";

let dir: string;
let agentDir: string;
let projectDir: string;

/**
 * 配置告警不再直写 console.warn，而是先入缓冲、由 index.ts 在 session_start 安装出口后补发
 * （spec 2026-11-18）。这里装一个收集出口：既验证「告警发没发」，也验证「发到哪」——
 * 加载期产生的告警只会落到这个数组，不会漏到终端。
 */
let warnings: string[] = [];

function warned(): string {
	return warnings.join(" ");
}

function writeGlobal(obj: unknown) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify(obj));
}
function writeProject(obj: unknown) {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "sandbox.json"), JSON.stringify(obj));
}
function writeWritable(content: unknown) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "sandbox-writable.json"), typeof content === "string" ? content : JSON.stringify(content));
}
function writeProjectWritable(content: unknown) {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "sandbox-writable.json"), JSON.stringify(content));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cfg-"));
	agentDir = join(dir, "agent");
	projectDir = join(dir, "project");
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	resetConfigWarningStateForTests();
	warnings = [];
	setConfigWarningSink((message) => warnings.push(message));
});
afterEach(() => {
	resetConfigWarningStateForTests();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("loadSandboxConfig", () => {
	it("falls back to defaults when no files exist", () => {
		expect(loadSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("reads the global file", () => {
		writeGlobal({ mode: "read-only", probeTimeoutMs: 1000 });
		const cfg = loadSandboxConfig();
		expect(cfg.mode).toBe("read-only");
		expect(cfg.probeTimeoutMs).toBe(1000);
		expect(cfg.runnerCommand).toBeNull();
	});
	it("project-level sandbox.json is ignored silently: no field merges, no warning", () => {
		writeGlobal({ probeTimeoutMs: 1000 });
		// 项目文件刻意写最宽松/最危险的组合：一个字段都不得参与解析，也不得告警。
		writeProject({ mode: "danger-full-access", runnerCommand: ["r"], runnerFailureSignatures: ["r:"], probeTimeoutMs: 0 });
		const cfg = loadSandboxConfig();
		expect(cfg.mode).toBe(DEFAULT_SANDBOX_CONFIG.mode); // 项目 mode 不生效
		expect(cfg.probeTimeoutMs).toBe(1000); // 全局字段不被项目覆盖
		expect(cfg.runnerCommand).toBeNull(); // 项目 runnerCommand 完全不进入解析
		expect(warnings).toEqual([]);
	});
	it("a project file alone (no global file) leaves defaults in place", () => {
		writeProject({ mode: "read-only", probeTimeoutMs: 1000 });
		expect(loadSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("invalid global mode warns and falls back to default", () => {
		writeGlobal({ mode: "yolo" });
		expect(loadSandboxConfig().mode).toBe("workspace-write");
		expect(warned()).toMatch(/invalid mode/u);
	});
	it("legacy 1.x groups are ignored with a warning", () => {
		writeGlobal({ image: { name: "x" }, runtime: { engine: "docker" }, host: { commands: [] }, mode: "read-only" });
		expect(loadSandboxConfig().mode).toBe("read-only");
		expect(warned()).toMatch(/legacy/);
	});
	it("corrupt global JSON is ignored (defaults)", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "sandbox.json"), "{broken");
		expect(loadSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("non-object JSON (array/number/string/boolean) counts as corrupt (I2)", () => {
		mkdirSync(agentDir, { recursive: true });
		const path = join(agentDir, "sandbox.json");
		for (const content of ["5", "[1,2]", '"workspace-write"', "true", "null"]) {
			writeFileSync(path, content);
			expect(loadSandboxConfig(), content).toEqual(DEFAULT_SANDBOX_CONFIG); // 不抛
		}
	});
});

describe("toolStorage", () => {
	it("enables built-in tool storage by default", () => {
		expect(loadSandboxConfig().toolStorage).toBe(true);
	});
	it.each([true, false])("preserves explicit %s", (enabled) => {
		writeGlobal({ toolStorage: enabled });
		expect(loadSandboxConfig().toolStorage).toBe(enabled);
	});
	it("warns and falls back to enabled for a non-boolean value", () => {
		writeGlobal({ toolStorage: "false" });
		expect(loadSandboxConfig().toolStorage).toBe(true);
		expect(warned()).toMatch(/invalid toolStorage/u);
	});
	it("ignores the project-level field silently", () => {
		writeProject({ toolStorage: false });
		expect(loadSandboxConfig().toolStorage).toBe(true);
		expect(warnings).toEqual([]);
	});
	it("keeps the field independent from a corrupt sandbox-writable.json", () => {
		writeGlobal({ toolStorage: false });
		writeWritable("{broken");
		expect(loadSandboxConfig().toolStorage).toBe(false);
		expect(warned()).toMatch(/not valid JSON/u);
	});
});

describe("getSandboxConfig (fail-safe + cache)", () => {
	afterEach(() => { resetSandboxConfigCache(); });
	it("pairing-violation global config falls back to DEFAULT with a warn, never throws (I2)", () => {
		writeGlobal({ runnerCommand: ["myrunner"] }); // 缺 runnerFailureSignatures → validate throw
		expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
		expect(warned()).toMatch(/falling back to defaults/u);
	});
	it("sandbox.json 校验失败回落默认时仍保留新文件的授权（失败隔离是双向的）", () => {
		const extra = join(dir, "isolated-extra");
		mkdirSync(extra);
		writeGlobal({ runnerCommand: ["myrunner"] }); // 缺配对 → validate throw → fail-safe
		writeWritable([extra]);
		resetSandboxConfigCache();
		const cfg = getSandboxConfig();
		expect(cfg.mode).toBe(DEFAULT_SANDBOX_CONFIG.mode);
		expect(cfg.extraWritableDirs).toEqual([realpathSync.native(extra)]);
	});
	it("caches: second call does not re-warn", () => {
		writeGlobal({ probeTimeoutMs: 0 }); // 非法 → throw → fail-safe
		expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
		expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
		expect(warnings).toHaveLength(1);
	});
	it("a project-level file never enters the fail-safe path", () => {
		writeProject({ runnerCommand: ["myrunner"] }); // 旧行为下这会 throw → fail-safe warn
		expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
		expect(warnings).toEqual([]);
	});
});

describe("validateSandboxConfig", () => {
	it("runnerCommand requires runnerFailureSignatures and vice versa", () => {
		expect(() => validateSandboxConfig({ runnerCommand: ["myrunner"] }, "test")).toThrow(/runnerFailureSignatures/);
		expect(() => validateSandboxConfig({ runnerFailureSignatures: ["x:"] }, "test")).toThrow(/runnerCommand/);
	});
	it("signatures must be non-empty single-line strings", () => {
		expect(() => validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: [""] }, "t")).toThrow();
		expect(() => validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: ["a\nb"] }, "t")).toThrow();
	});
	it("valid pair passes through", () => {
		const cfg = validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: ["r:"] }, "t");
		expect(cfg.runnerCommand).toEqual(["r"]);
	});
	it("probeTimeoutMs must be a positive finite number (0 means unbounded to Node)", () => {
		expect(() => validateSandboxConfig({ probeTimeoutMs: 0 }, "t")).toThrow(/probeTimeoutMs/);
		expect(() => validateSandboxConfig({ probeTimeoutMs: Number.NaN }, "t")).toThrow(/probeTimeoutMs/);
		expect(validateSandboxConfig({ probeTimeoutMs: 100 }, "t").probeTimeoutMs).toBe(100);
	});
	it("不再校验 extraWritableDirs（该字段已迁出 sandbox.json），返回空列表", () => {
		const cfg = validateSandboxConfig({ extraWritableDirs: "nope" }, "t");
		expect(cfg.extraWritableDirs).toEqual([]);
	});
});

describe("extraWritableDirs（独立文件 sandbox-writable.json）", () => {
	it("文件缺失时为空数组且不告警（与空数组等价，Review Focus #5）", () => {
		expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
		expect(DEFAULT_SANDBOX_CONFIG.extraWritableDirs).toEqual([]);
		expect(warnings).toEqual([]);
	});
	it("解析已存在目录，按 canonical 拼写去重并保持顺序", () => {
		const a = join(dir, "extra-a");
		const b = join(dir, "extra-b");
		mkdirSync(a);
		mkdirSync(b);
		writeWritable([a, a, join(a, "."), b]);
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(a), realpathSync.native(b)]);
	});
	it("展开 ~/ 到用户主目录", () => {
		const home = join(dir, "home");
		mkdirSync(join(home, "cache"), { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		writeWritable(["~/cache"]);
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(join(home, "cache"))]);
	});
	it("非绝对、~user、缺失、文件条目都告警并丢弃，其余条目照常", () => {
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x");
		const ok = join(dir, "extra-ok");
		mkdirSync(ok);
		writeWritable(["relative/cache", "~someone/cache", join(dir, "missing"), file, ok]);
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(ok)]);
		const text = warned();
		expect(text).toMatch(/extraWritableDirs/);
		// 逐条语义各有自己的告警：relative/cache 与 ~someone/cache 不是绝对路径，
		// missing 与 not-a-dir 不是已存在目录。
		expect(text.match(/not an absolute path/gu)).toHaveLength(2);
		expect(text.match(/not an existing directory/gu)).toHaveLength(2);
	});
	it("顶层不是数组 / 含非字符串元素：告警 + 空列表，且不连坐 sandbox.json（Review Focus #1 #2）", () => {
		writeGlobal({ mode: "read-only", probeTimeoutMs: 1234 });
		const cases = [
			// writeWritable 对字符串是原样写入，所以裸文本/裸路径属于“JSON 非法”分支
			{ content: "{broken", expected: /is not valid JSON/u },
			{ content: "nope", expected: /is not valid JSON/u },
			{ content: "/abs/path", expected: /is not valid JSON/u },
			{ content: 5, expected: /must be a JSON array of path strings/u },
			{ content: { dirs: ["/tmp"] }, expected: /must be a JSON array of path strings/u },
			{ content: [1, 2], expected: /must be a JSON array of path strings/u },
			{ content: ["/tmp", null], expected: /must be a JSON array of path strings/u },
		] as const;
		for (const { content, expected } of cases) {
			// 逐轮清告警：否则解析分支的告警会喂饱循环外的断言，另两个分支就没被钉住。
			warnings = [];
			writeWritable(content);
			resetSandboxConfigCache();
			const label = String(content);
			const cfg = loadSandboxConfig(); // 不抛
			expect(cfg.extraWritableDirs, label).toEqual([]);
			expect(cfg.mode, label).toBe("read-only");
			expect(cfg.probeTimeoutMs, label).toBe(1234);
			expect(warned(), label).toMatch(expected);
		}
	});
	it("新文件不可读（非 ENOENT，例如同名目录）：告警 + 空列表，不静默", () => {
		mkdirSync(join(agentDir, "sandbox-writable.json"), { recursive: true }); // 同名目录 → EISDIR
		expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
		expect(warned()).toMatch(/sandbox-writable\.json/u);
	});
	it("只写 sandbox-writable.json 时其余字段仍是默认（sandbox.json 缺失）", () => {
		const extra = join(dir, "only-writable");
		mkdirSync(extra);
		writeWritable([extra]);
		const cfg = loadSandboxConfig();
		expect(cfg.extraWritableDirs).toEqual([realpathSync.native(extra)]);
		expect(cfg.mode).toBe(DEFAULT_SANDBOX_CONFIG.mode);
		expect(cfg.probeTimeoutMs).toBe(DEFAULT_SANDBOX_CONFIG.probeTimeoutMs);
		expect(cfg.runnerCommand).toBeNull();
	});
	it("空数组与文件缺失等价：空列表且不告警", () => {
		writeWritable([]);
		expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
		expect(warnings).toEqual([]);
	});
	it("sandbox.json 里的旧字段告警并忽略，新文件的值仍生效（Review Focus #3）", () => {
		const legacyDir = join(dir, "legacy-extra");
		const newDir = join(dir, "new-extra");
		mkdirSync(legacyDir);
		mkdirSync(newDir);
		writeGlobal({ mode: "read-only", extraWritableDirs: [legacyDir] });
		writeWritable([newDir]);
		const cfg = loadSandboxConfig();
		expect(cfg.mode).toBe("read-only");
		expect(cfg.extraWritableDirs).toEqual([realpathSync.native(newDir)]);
		const text = warned();
		expect(text).toMatch(/ignoring/);
		expect(text).toMatch(/moved to/);
	});
	it("项目级 sandbox-writable.json 静默忽略，即使全局文件缺失（Review Focus #4）", () => {
		const projectExtra = join(dir, "project-extra");
		mkdirSync(projectExtra);
		writeProjectWritable([projectExtra]);
		// 被测代码唯一可能读到项目层的路径是 process.cwd()：把 cwd 真的放到项目目录，
		// 否则夹具与 cwd 永不相交，这条断言会变成装饰性的（变异不敏感）。
		const prev = process.cwd();
		try {
			process.chdir(projectDir);
			expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
			expect(warnings).toEqual([]);
		} finally {
			process.chdir(prev);
		}
	});
	it("条目等于 pi 的 agent 目录：告警但仍保留该条（warn-only，不丢弃）", () => {
		writeWritable([agentDir]);
		const cfg = loadSandboxConfig();
		expect(cfg.extraWritableDirs).toEqual([realpathSync.native(agentDir)]);
		expect(warned()).toMatch(/agent dir/);
	});
});

describe("配置告警的落点（spec 2026-11-18）", () => {
	it("没有安装出口（factory 顶部加载配置那一刻）时不往终端写字，告警留在缓冲里", () => {
		setConfigWarningSink(null); // 回到「还没有 ctx」的状态
		const rawWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeWritable([join(dir, "missing-dir")]);
			expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
			expect(rawWarn).not.toHaveBeenCalled();
			expect(warnings).toEqual([]); // 收集出口已摘除，告警不进它
			// 告警在缓冲里等人接管（index.ts 会在 session_start 安装出口补发）
			expect(takeConfigWarnings().join(" ")).toMatch(/not an existing directory/u);
		} finally {
			rawWarn.mockRestore();
		}
	});
});
