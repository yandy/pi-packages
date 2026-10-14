import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		expect(loadSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("merges fieldwise: project > global > default", () => {
		writeGlobal({ mode: "read-only", probeTimeoutMs: 1000 });
		writeProject({ mode: "workspace-write" });
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.mode).toBe("workspace-write");
		expect(cfg.probeTimeoutMs).toBe(1000);
		expect(cfg.runnerCommand).toBeNull();
	});
	it("invalid mode warns and falls back to default", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ mode: "yolo" });
		expect(loadSandboxConfig(projectDir).mode).toBe("workspace-write");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
	it("legacy 1.x groups are ignored with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ image: { name: "x" }, runtime: { engine: "docker" }, host: { commands: [] }, mode: "read-only" });
		expect(loadSandboxConfig(projectDir).mode).toBe("read-only");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/legacy/);
		warn.mockRestore();
	});
	it("corrupt JSON is ignored (defaults)", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "sandbox.json"), "{broken");
		expect(loadSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("non-object JSON (array/number/string/boolean) counts as corrupt (I2)", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const path = join(projectDir, ".pi", "sandbox.json");
		for (const content of ["5", "[1,2]", '"workspace-write"', "true", "null"]) {
			writeFileSync(path, content);
			expect(loadSandboxConfig(projectDir), content).toEqual(DEFAULT_SANDBOX_CONFIG); // 不抛
		}
	});
});

describe("getSandboxConfig (fail-safe + cache)", () => {
	afterEach(() => { resetSandboxConfigCache(); });
	it("pairing-violation config falls back to DEFAULT with a warn, never throws (I2)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ runnerCommand: ["myrunner"] }); // 缺 runnerFailureSignatures → validate throw
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/falling back to defaults/u);
		} finally {
			warn.mockRestore();
		}
	});
	it("caches per cwd: second call does not re-warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ probeTimeoutMs: 0 }); // 非法 → throw → fail-safe
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn).toHaveBeenCalledTimes(1);
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
	// schema v3（spec 2026-10-14 §4.1）：结构性错误 throw（与 runnerCommand 同口径，由 getSandboxConfig
	// 的 fail-safe 回落整份默认）；单条条目的问题不 throw，由 resolveConfiguredRoots warn + 丢弃。
	it("writableRoots defaults to an empty array and passes a string array through (copied, not aliased)", () => {
		expect(validateSandboxConfig({}, "t").writableRoots).toEqual([]);
		const input = ["~/.cache/uv"];
		const cfg = validateSandboxConfig({ writableRoots: input }, "t");
		expect(cfg.writableRoots).toEqual(["~/.cache/uv"]);
		expect(cfg.writableRoots).not.toBe(input);
	});
	it("writableRoots must be a string array", () => {
		for (const bad of ["~/.cache", 42, [1], ["ok", 2], {}]) {
			expect(() => validateSandboxConfig({ writableRoots: bad }, "t"), JSON.stringify(bad)).toThrow(/writableRoots/);
		}
	});
	it("writableRoots: null means unset (same `??` convention as runnerCommand), not an error", () => {
		expect(validateSandboxConfig({ writableRoots: null }, "t").writableRoots).toEqual([]);
	});
});

describe("writableRoots merges like every other field", () => {
	// 与 mode / runnerCommand / probeTimeoutMs 同一条合并规则：项目 > 全局 > 默认。
	// 放宽边界的风险由**与来源无关**的两层承担：危险根拒绝（configured-roots.test.ts）
	// 与 <ws>/.pi 的恒只读挖洞（fence.test.ts）。
	it("takes the value from the global config when the project sets none", () => {
		writeGlobal({ writableRoots: ["~/.cache/uv"] });
		expect(loadSandboxConfig(projectDir).writableRoots).toEqual(["~/.cache/uv"]);
	});
	it("project level wins over global, same as mode/probeTimeoutMs", () => {
		writeGlobal({ writableRoots: ["~/.cache/uv"], probeTimeoutMs: 1000 });
		writeProject({ writableRoots: ["/opt/scratch"] });
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.writableRoots).toEqual(["/opt/scratch"]);
		expect(cfg.probeTimeoutMs).toBe(1000);
	});
	it("does not warn about project-level entries (they are ordinary config now)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ writableRoots: ["/opt/scratch"] });
			expect(loadSandboxConfig(projectDir).writableRoots).toEqual(["/opt/scratch"]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
	it("an explicitly empty project list overrides a non-empty global one", () => {
		// `[] ?? x` 是 `[]`（空数组不是 nullish），所以项目可以用空列表关掉全局授予——收窄方向必须可用。
		writeGlobal({ writableRoots: ["~/.cache/uv"] });
		writeProject({ writableRoots: [] });
		expect(loadSandboxConfig(projectDir).writableRoots).toEqual([]);
	});
});
