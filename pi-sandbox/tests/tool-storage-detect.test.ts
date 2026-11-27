import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	detectToolStorage,
	getToolStoragePlan,
	resetToolStoragePlanCache,
	usablePnpmRuntimeRoot,
	type ToolStorageDetectDeps,
} from "../src/tool-storage/detect";

let dir: string;
let home: string;
let agentDir: string;
let workspace: string;
let bin: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tool-storage-detect-"));
	home = join(dir, "home");
	agentDir = join(dir, "agent");
	workspace = join(dir, "workspace");
	bin = join(dir, "bin");
	for (const path of [home, agentDir, workspace, bin]) mkdirSync(path, { recursive: true });
});

afterEach(() => {
	resetToolStoragePlanCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function executable(name: string, marker?: string): string {
	const path = join(bin, name);
	writeFileSync(path, marker === undefined ? "" : `#!/bin/sh\nprintf x > ${JSON.stringify(marker)}\n`);
	chmodSync(path, 0o755);
	return path;
}

function detect(env: NodeJS.ProcessEnv, deps: ToolStorageDetectDeps = {}) {
	return detectToolStorage(workspace, { env, home, agentDir, uid: 1000, ...deps });
}

describe("tool storage detection", () => {
	it("returns an empty plan for an empty PATH", () => {
		const plan = detect({ PATH: "" });
		expect(plan.profiles).toEqual([]);
		expect(plan.roots).toEqual([]);
		expect(plan.sharedRoots).toContain(home);
		expect(plan).not.toHaveProperty("env");
	});

	it("detects uv without executing the candidate", () => {
		const marker = join(dir, "executed");
		executable("uv", marker);
		const plan = detect({ PATH: bin });
		expect(plan.profiles).toEqual(["uv"]);
		expect(existsSync(marker)).toBe(false);
	});

	it("detects vcpkg and Playwright without executing the candidates", () => {
		const marker = join(dir, "executed");
		executable("vcpkg", marker);
		executable("playwright", marker);
		expect(detect({ PATH: bin }).profiles).toEqual(["vcpkg", "playwright"]);
		expect(existsSync(marker)).toBe(false);
	});

	it.each(["playwright", "playwright-cli"])('detects the standalone %s CLI on PATH', (name) => {
		executable(name);
		expect(detect({ PATH: bin }).profiles).toEqual(["playwright"]);
	});

	it.each([
		"playwright", "playwright.cmd", "playwright.ps1",
		"playwright-cli", "playwright-cli.cmd", "playwright-cli.ps1",
	])("distinguishes local %s from a generic npx launcher", (name) => {
		executable("npx");
		expect(detect({ PATH: bin }).profiles).toEqual(["npm"]);
		const localBin = join(workspace, "node_modules", ".bin");
		mkdirSync(localBin, { recursive: true });
		writeFileSync(join(localBin, name), "");
		expect(detect({ PATH: bin }).profiles).toEqual(["npm", "playwright"]);
	});

	it.each([".venv", "venv"])("detects the Python Playwright script in a local %s without an activated PATH", (venv) => {
		executable("python");
		expect(detect({ PATH: bin }).profiles).toEqual(["pip"]);
		const scripts = process.platform === "win32" ? join(workspace, venv, "Scripts") : join(workspace, venv, "bin");
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, process.platform === "win32" ? "playwright.exe" : "playwright"), "");
		expect(detect({ PATH: bin }).profiles).toEqual(["pip", "playwright"]);
	});

	it("detects Windows virtualenv Playwright executables without a host Windows filesystem", () => {
		// Windows canonicalization may change the drive-letter case and NTFS paths are
		// case-insensitive, so the injected probe compares case-insensitively.
		const expected = win32.join(workspace, "venv", "Scripts", "playwright.exe").toLowerCase();
		const plan = detect(
			{ PATH: "" },
			{
				platform: "win32",
				home: "C:\\Users\\Alice",
				agentDir: "C:\\Users\\Alice\\.pi\\agent",
				isFile: (path) => path.toLowerCase() === expected,
			},
		);
		expect(plan.profiles).toEqual(["playwright"]);
	});

	it("detects pip through a Python launcher", () => {
		executable("python");
		expect(detect({ PATH: bin }).profiles).toEqual(["pip"]);
	});

	it("activates Corepack, pnpm, and Yarn for a Corepack shim", () => {
		executable("corepack");
		expect(detect({ PATH: bin }).profiles).toEqual(["corepack", "pnpm", "yarn"]);
	});

	it("detects fixed Maven and Gradle wrapper files in the workspace", () => {
		writeFileSync(join(workspace, "mvnw"), "");
		writeFileSync(join(workspace, "gradlew.bat"), "");
		expect(detect({ PATH: "" }).profiles).toEqual(["maven", "gradle"]);
	});

	it("keeps profile order stable and deduplicates shared root paths", () => {
		executable("uv");
		executable("pip");
		const shared = join(dir, "shared-cache");
		const plan = detect({ PATH: bin, PIP_CACHE_DIR: shared, UV_CACHE_DIR: shared });
		expect(plan.profiles).toEqual(["pip", "uv"]);
		expect(plan.roots.map((root) => root.path)).toEqual([
			shared,
			process.platform === "win32"
				? join(home, "AppData", "Roaming", "uv", "data", "python")
				: join(home, ".local", "share", "uv", "python"),
		]);
	});

	it.skipIf(process.platform === "win32")("does not treat a non-executable POSIX file as a PATH entry", () => {
		const path = join(bin, "uv");
		writeFileSync(path, "");
		chmodSync(path, 0o644);
		expect(detect({ PATH: bin }).profiles).toEqual([]);
	});

	it("resolves a relative PATH entry against the workspace", () => {
		const relativeBin = join(workspace, "bin");
		mkdirSync(relativeBin);
		writeFileSync(join(relativeBin, "uv"), "");
		chmodSync(join(relativeBin, "uv"), 0o755);
		expect(detect({ PATH: "bin" }).profiles).toEqual(["uv"]);
	});

	it("uses Windows PATHEXT without requiring a host Windows filesystem", () => {
		const seen: string[] = [];
		const plan = detect(
			{ PATH: "C:\\tools", PATHEXT: ".CMD;.EXE" },
			{
				platform: "win32",
				home: "C:\\Users\\Alice",
				agentDir: "C:\\Users\\Alice\\.pi\\agent",
				isExecutable: (path) => {
					seen.push(path);
					return path === "C:\\tools\\pnpm.CMD";
				},
				isFile: () => false,
			},
		);
		expect(seen).toContain("C:\\tools\\pnpm.CMD");
		expect(plan.profiles).toEqual(["corepack", "pnpm"]);
		expect(plan.roots.every((root) => win32.isAbsolute(root.path))).toBe(true);
	});
});

describe("usablePnpmRuntimeRoot", () => {
	it.skipIf(process.platform === "win32")("accepts only an absolute, owned, accessible, non-group/world-writable POSIX directory", () => {
		const uid = process.getuid?.() ?? null;
		if (uid === null) return;
		const runtime = join(dir, "runtime");
		mkdirSync(runtime, { mode: 0o700 });
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: runtime }, "linux", uid)).toBe(runtime);
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: runtime }, "linux", uid + 1)).toBeNull();
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: runtime }, "linux", null)).toBeNull();
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: "relative" }, "linux", uid)).toBeNull();
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: join(dir, "missing") }, "linux", uid)).toBeNull();
		for (const mode of [0o777, 0o770, 0o500, 0o600]) {
			chmodSync(runtime, mode);
			expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: runtime }, "linux", uid)).toBeNull();
		}
	});

	it("does not select an XDG runtime root on Windows", () => {
		expect(usablePnpmRuntimeRoot({ XDG_RUNTIME_DIR: "C:\\run" }, "win32", 1000)).toBeNull();
	});
});

describe("getToolStoragePlan cache", () => {
	it("reuses a canonical workspace plan until reset", () => {
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PATH", bin);
		executable("uv");
		const first = getToolStoragePlan(workspace);
		expect(first.profiles).toEqual(["uv"]);
		rmSync(join(bin, "uv"));
		expect(getToolStoragePlan(workspace)).toBe(first);
		resetToolStoragePlanCache();
		expect(getToolStoragePlan(workspace).profiles).toEqual([]);
	});
});
