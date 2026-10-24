import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, getSandboxConfig, loadSandboxConfig, resetSandboxConfigCache, validateSandboxConfig } from "../src/config";

let dir: string;
let agentDir: string;
let projectDir: string;

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
});
afterEach(() => {
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeGlobal({ probeTimeoutMs: 1000 });
			// 项目文件刻意写最宽松/最危险的组合：一个字段都不得参与解析，也不得告警。
			writeProject({ mode: "danger-full-access", runnerCommand: ["r"], runnerFailureSignatures: ["r:"], probeTimeoutMs: 0 });
			const cfg = loadSandboxConfig();
			expect(cfg.mode).toBe(DEFAULT_SANDBOX_CONFIG.mode); // 项目 mode 不生效
			expect(cfg.probeTimeoutMs).toBe(1000); // 全局字段不被项目覆盖
			expect(cfg.runnerCommand).toBeNull(); // 项目 runnerCommand 完全不进入解析
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
	it("a project file alone (no global file) leaves defaults in place", () => {
		writeProject({ mode: "read-only", probeTimeoutMs: 1000 });
		expect(loadSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("invalid global mode warns and falls back to default", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal({ mode: "yolo" });
		expect(loadSandboxConfig().mode).toBe("workspace-write");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
	it("legacy 1.x groups are ignored with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal({ image: { name: "x" }, runtime: { engine: "docker" }, host: { commands: [] }, mode: "read-only" });
		expect(loadSandboxConfig().mode).toBe("read-only");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/legacy/);
		warn.mockRestore();
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

describe("getSandboxConfig (fail-safe + cache)", () => {
	afterEach(() => { resetSandboxConfigCache(); });
	it("pairing-violation global config falls back to DEFAULT with a warn, never throws (I2)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeGlobal({ runnerCommand: ["myrunner"] }); // 缺 runnerFailureSignatures → validate throw
			expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/falling back to defaults/u);
		} finally {
			warn.mockRestore();
		}
	});
	it("caches: second call does not re-warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeGlobal({ probeTimeoutMs: 0 }); // 非法 → throw → fail-safe
			expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
	it("a project-level file never enters the fail-safe path", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ runnerCommand: ["myrunner"] }); // 旧行为下这会 throw → fail-safe warn
			expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
			expect(DEFAULT_SANDBOX_CONFIG.extraWritableDirs).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const file = join(dir, "not-a-dir");
			writeFileSync(file, "x");
			const ok = join(dir, "extra-ok");
			mkdirSync(ok);
			writeWritable(["relative/cache", "~someone/cache", join(dir, "missing"), file, ok]);
			expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(ok)]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/extraWritableDirs/);
		} finally {
			warn.mockRestore();
		}
	});
	it("顶层不是数组 / 含非字符串元素：告警 + 空列表，且不连坐 sandbox.json（Review Focus #1 #2）", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeGlobal({ mode: "read-only", probeTimeoutMs: 1234 });
			for (const bad of ["{broken", "nope", "/abs/path", 5, { dirs: ["/tmp"] }, [1, 2], ["/tmp", null]] as const) {
				writeWritable(bad);
				resetSandboxConfigCache();
				const cfg = loadSandboxConfig(); // 不抛
				expect(cfg.extraWritableDirs, String(bad)).toEqual([]);
				expect(cfg.mode, String(bad)).toBe("read-only");
				expect(cfg.probeTimeoutMs, String(bad)).toBe(1234);
			}
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
	it("sandbox.json 里的旧字段告警并忽略，新文件的值仍生效（Review Focus #3）", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const legacyDir = join(dir, "legacy-extra");
			const newDir = join(dir, "new-extra");
			mkdirSync(legacyDir);
			mkdirSync(newDir);
			writeGlobal({ mode: "read-only", extraWritableDirs: [legacyDir] });
			writeWritable([newDir]);
			const cfg = loadSandboxConfig();
			expect(cfg.mode).toBe("read-only");
			expect(cfg.extraWritableDirs).toEqual([realpathSync.native(newDir)]);
			const warned = warn.mock.calls.flat().join(" ");
			expect(warned).toMatch(/ignoring/);
			expect(warned).toMatch(/moved to/);
		} finally {
			warn.mockRestore();
		}
	});
	it("项目级 sandbox-writable.json 静默忽略，即使全局文件缺失（Review Focus #4）", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const projectExtra = join(dir, "project-extra");
			mkdirSync(projectExtra);
			writeProjectWritable([projectExtra]);
			expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
	it("条目等于 pi 的 agent 目录：告警但仍保留该条（warn-only，不丢弃）", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeWritable([agentDir]);
			const cfg = loadSandboxConfig();
			expect(cfg.extraWritableDirs).toEqual([realpathSync.native(agentDir)]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/agent dir/);
		} finally {
			warn.mockRestore();
		}
	});
});
