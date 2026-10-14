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
});

describe("extraWritableDirs", () => {
	it("默认是空数组", () => {
		expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
		expect(DEFAULT_SANDBOX_CONFIG.extraWritableDirs).toEqual([]);
	});
	it("解析已存在目录，按 canonical 拼写去重并保持顺序", () => {
		const a = join(dir, "extra-a"); const b = join(dir, "extra-b");
		mkdirSync(a); mkdirSync(b);
		writeGlobal({ extraWritableDirs: [a, a, join(a, "."), b] });
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(a), realpathSync.native(b)]);
	});
	it("展开 ~/ 到用户主目录", () => {
		const home = join(dir, "home"); mkdirSync(join(home, "cache"), { recursive: true });
		vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
		writeGlobal({ extraWritableDirs: ["~/cache"] });
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(join(home, "cache"))]);
	});
	it("非绝对、~user、缺失、文件条目都告警并丢弃，其余条目照常", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const file = join(dir, "not-a-dir"); writeFileSync(file, "x");
		const ok = join(dir, "extra-ok"); mkdirSync(ok);
		writeGlobal({ extraWritableDirs: ["relative/cache", "~someone/cache", join(dir, "missing"), file, ok] });
		expect(loadSandboxConfig().extraWritableDirs).toEqual([realpathSync.native(ok)]);
		expect(warn.mock.calls.flat().join(" ")).toMatch(/extraWritableDirs/);
		warn.mockRestore();
	});
	it("结构错误（非数组/非字符串元素）整份回退默认并告警", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const bad of ["nope", [1, 2]] as const) {
			writeGlobal({ extraWritableDirs: bad });
			resetSandboxConfigCache();
			expect(() => loadSandboxConfig()).toThrow(/extraWritableDirs must be a string array/);
			expect(getSandboxConfig().extraWritableDirs).toEqual([]);
		}
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
	it("项目级文件里的 extraWritableDirs 仍被静默忽略", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ extraWritableDirs: [dir] });
		expect(loadSandboxConfig().extraWritableDirs).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
