import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolStoragePlan } from "../src/tool-storage/detect";
import {
	materializeToolStorageRoots,
	resetToolStorageWarnings,
	unsafeToolStorageRoot,
} from "../src/tool-storage/materialize";

let dir: string;
let home: string;
let agentDir: string;
let workspace: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tool-storage-materialize-"));
	home = join(dir, "home");
	agentDir = join(dir, "agent");
	workspace = join(dir, "workspace");
	for (const path of [home, agentDir, workspace]) mkdirSync(path, { recursive: true });
	resetToolStorageWarnings();
});

afterEach(() => {
	resetToolStorageWarnings();
	rmSync(dir, { recursive: true, force: true });
});

function plan(paths: string[], overrides: Partial<ToolStoragePlan> = {}): ToolStoragePlan {
	return {
		platform: "linux",
		home,
		agentDir,
		workspaceRoot: workspace,
		sharedRoots: [home],
		profiles: [],
		roots: paths.map((path) => ({ profile: "uv", path })),
		...overrides,
	};
}

describe("materializeToolStorageRoots", () => {
	it("creates missing roots, reuses existing roots, and canonicalizes duplicates", () => {
		const uv = join(dir, "storage", "uv");
		const pip = join(dir, "storage", "pip");
		mkdirSync(pip, { recursive: true });
		const result = materializeToolStorageRoots(plan([uv, pip, join(uv, ".")]), { warn: () => {} });
		expect(result).toEqual([realpathSync.native(uv), realpathSync.native(pip)]);
		for (const path of result) expect(statSync(path).isDirectory()).toBe(true);
		expect(materializeToolStorageRoots(plan([uv, pip]), { warn: () => {} })).toEqual(result);
	});

	it.skipIf(process.platform === "win32")("deduplicates a symlink onto its safe real directory", () => {
		const real = join(dir, "storage");
		const link = join(dir, "storage-link");
		mkdirSync(real);
		symlinkSync(real, link);
		expect(materializeToolStorageRoots(plan([link, real]), { warn: () => {} })).toEqual([realpathSync.native(real)]);
	});

	it("recreates a root deleted after an earlier call", () => {
		const cache = join(dir, "storage", "uv");
		const roots = plan([cache]);
		expect(materializeToolStorageRoots(roots, { warn: () => {} })).toEqual([realpathSync.native(cache)]);
		rmSync(cache, { recursive: true, force: true });
		expect(exists(cache)).toBe(false);
		expect(materializeToolStorageRoots(roots, { warn: () => {} })).toEqual([realpathSync.native(cache)]);
		expect(statSync(cache).isDirectory()).toBe(true);
	});

	it("isolates one root's failure, warns once, and retries on later calls", () => {
		const good = join(dir, "good");
		const bad = join(dir, "bad");
		let fail = true;
		const warnings: string[] = [];
		const mkdir = vi.fn((path: string) => {
			if (path === bad && fail) throw new Error("denied");
			mkdirSync(path, { recursive: true });
		});
		const deps = { mkdir: mkdir as unknown as typeof mkdirSync, warn: (message: string) => warnings.push(message) };
		expect(materializeToolStorageRoots(plan([bad, good]), deps)).toEqual([realpathSync.native(good)]);
		expect(materializeToolStorageRoots(plan([bad, good]), deps)).toEqual([realpathSync.native(good)]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(bad);
		fail = false;
		expect(materializeToolStorageRoots(plan([bad, good]), deps)).toEqual([realpathSync.native(bad), realpathSync.native(good)]);
		expect(mkdir.mock.calls.filter(([path]) => path === bad)).toHaveLength(3);
	});

	it("does not call mkdir for a lexically dangerous root", () => {
		const mkdir = vi.fn();
		const dangerous = join(home, ".ssh");
		expect(materializeToolStorageRoots(plan([dangerous]), {
			mkdir: mkdir as unknown as typeof mkdirSync,
			warn: () => {},
		})).toEqual([]);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("rejects an existing file instead of granting it", () => {
		const file = join(dir, "not-a-directory");
		writeFileSync(file, "x");
		expect(materializeToolStorageRoots(plan([file]), { warn: () => {} })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects a safe-looking symlink whose real target is a credential directory", () => {
		const target = join(home, ".ssh");
		const link = join(dir, "safe-looking-cache");
		mkdirSync(target);
		symlinkSync(target, link);
		expect(unsafeToolStorageRoot(link, plan([]))).toBeNull();
		expect(materializeToolStorageRoots(plan([link]), { warn: () => {} })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects a dangerous symlink ancestor before creating a missing leaf", () => {
		const target = join(home, ".ssh");
		const link = join(dir, "credential-link");
		const missingLeaf = join(link, "cache");
		mkdirSync(target);
		symlinkSync(target, link);
		const mkdir = vi.fn((path: string) => mkdirSync(path, { recursive: true }));
		expect(materializeToolStorageRoots(plan([missingLeaf]), {
			mkdir: mkdir as unknown as typeof mkdirSync,
			warn: () => {},
		})).toEqual([]);
		expect(mkdir).not.toHaveBeenCalled();
		expect(exists(join(target, "cache"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("rejects the real target of a credential directory that is itself a symlink", () => {
		const realCredentials = join(dir, "real-credentials");
		mkdirSync(realCredentials);
		symlinkSync(realCredentials, join(home, ".ssh"));
		expect(materializeToolStorageRoots(plan([realCredentials]), { warn: () => {} })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("checks real targets against a symlinked home and agent directory", () => {
		const realHome = join(dir, "real-home");
		const realAgent = join(dir, "real-agent");
		const linkedHome = join(dir, "linked-home");
		const linkedAgent = join(dir, "linked-agent");
		mkdirSync(join(realHome, ".ssh"), { recursive: true });
		mkdirSync(realAgent);
		symlinkSync(realHome, linkedHome);
		symlinkSync(realAgent, linkedAgent);
		const credentials = join(dir, "credentials-cache");
		const agentCache = join(dir, "agent-cache");
		symlinkSync(join(realHome, ".ssh"), credentials);
		symlinkSync(realAgent, agentCache);
		const symlinkedPlan = plan([credentials, agentCache], { home: linkedHome, agentDir: linkedAgent });
		expect(materializeToolStorageRoots(symlinkedPlan, { warn: () => {} })).toEqual([]);
	});
});

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

describe("unsafeToolStorageRoot", () => {
	it("rejects filesystem roots, home and its ancestors, but allows a normal child", () => {
		expect(unsafeToolStorageRoot("/", plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(dir, plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(home, plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(join(home, ".cache", "uv"), plan([]))).toBeNull();
	});

	it("rejects the agent directory, its children and ancestors on path boundaries", () => {
		expect(unsafeToolStorageRoot(agentDir, plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(join(agentDir, "cache"), plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(dir, plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(`${agentDir}-cache`, plan([]))).toBeNull();
	});

	it("rejects a shared base itself but permits its named tool child", () => {
		const shared = join(dir, "shared");
		expect(unsafeToolStorageRoot(shared, plan([], { sharedRoots: [shared] }))).not.toBeNull();
		expect(unsafeToolStorageRoot(join(shared, "uv"), plan([], { sharedRoots: [shared] }))).toBeNull();
	});

	it.each([".ssh", ".aws", ".gnupg", ".docker", ".kube", ".config", ".pi"])("rejects %s and its children", (name) => {
		expect(unsafeToolStorageRoot(join(home, name), plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(join(home, name, "cache"), plan([]))).not.toBeNull();
		expect(unsafeToolStorageRoot(join(home, `${name}-cache`), plan([]))).toBeNull();
	});

	it("rejects relative paths", () => {
		expect(unsafeToolStorageRoot("cache/uv", plan([]))).not.toBeNull();
	});

	it("uses Windows case-insensitive, separator-insensitive containment", () => {
		const windowsPlan = plan([], {
			platform: "win32",
			home: "C:\\Users\\Alice",
			agentDir: "C:\\Users\\Alice\\.pi\\agent",
			workspaceRoot: "D:\\work\\project",
			sharedRoots: ["C:\\Users\\Alice\\AppData\\Local"],
		});
		expect(unsafeToolStorageRoot("C:\\", windowsPlan)).not.toBeNull();
		expect(unsafeToolStorageRoot("c:/users/alice", windowsPlan)).not.toBeNull();
		expect(unsafeToolStorageRoot("C:/Users/Alice/AppData/Local", windowsPlan)).not.toBeNull();
		expect(unsafeToolStorageRoot("C:\\Users\\Alice\\.config\\tool", windowsPlan)).not.toBeNull();
		expect(unsafeToolStorageRoot("C:\\Users\\Alice\\AppData\\Local\\uv\\cache", windowsPlan)).toBeNull();
		expect(unsafeToolStorageRoot("D:\\cache", windowsPlan)).toBeNull();
	});
});
