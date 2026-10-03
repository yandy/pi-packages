// pi-sandbox/tests/win32/e2e.test.ts
/**
 * Windows-only end-to-end suite (design spec §10.2). It drives the REAL runner
 * as a subprocess — real restricted token, real DACL grants, real kill-on-close
 * Job — and is therefore the only evidence in this repository that the Windows
 * confinement works outside the mocked Win32 binding table that Tasks 1-16 test
 * on Linux.
 *
 * Deliberate boundaries:
 *  - The child is always reached through
 *    `node <pkg>/src/win32/runner.js --workspace <ws> --temp <tmp> --mode <m> -- <argv...>`
 *    exactly like the production seam builds it. `runner.js` is never imported
 *    here — importing it would bypass the process boundary that is under test.
 *  - Cases that need a live pi session (PowerShell language mode, hard-link
 *    aliasing, the Job teardown of a timed-out grandchild, two-session
 *    isolation, the pi-side acceptance of an inactive `powershell` tool
 *    registration, and the diagnosis-skill catalog) are NOT faked here; they
 *    live in
 *    `docs/superpowers/verification/2026-10-03-windows-acl-acceptance.md`.
 *  - The `bash` refusal is a pure TypeScript-layer assertion, so it runs on
 *    every platform. It intentionally duplicates the focused assertions in
 *    `tests/confine.test.ts`: this file is the one place that maps spec §10.2
 *    to test cases, and a reader must not have to hunt for it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertShellAllowed,
	classifyDenial,
	classifyRunnerFailure,
	DENIAL_SIGNATURES,
	RUNNER_FAILURE_RULES,
	UnsupportedWindowsShellError,
} from "../../src/confine";
import { canonicalPath, writableRoots } from "../../src/policy";
import { windowsAclRunnerArgv } from "../../src/runners";

const RUNNER = fileURLToPath(new URL("../../src/win32/runner.js", import.meta.url));
const RUNNER_SIGNATURE = "windows-acl-run: ";

/**
 * The first grant against the real `%TEMP%` eagerly propagates the inheritable
 * ACEs/label over the whole tree (design §4.7), which can take seconds on a
 * large temp directory; later invocations hit the exact-match skip. Every case
 * gets a generous budget so that first propagation is not misread as a hang.
 */
const E2E_TIMEOUT = 180_000;
const SPAWN_TIMEOUT = E2E_TIMEOUT - 15_000;

interface ConfinedResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

interface RunOverrides {
	/** Defaults to `canonicalPath(fixture workspace)` — the seam always passes canonical roots. */
	workspace?: string;
	/** Defaults to `canonicalPath(fixture granted temp)`; the `%TEMP%` case passes the real tmpdir. */
	temp?: string;
}

/** One `node -e <source> [args...]` child argv. */
function nodeScript(source: string, args: readonly string[] = []): string[] {
	return [process.execPath, "-e", source, ...args];
}

/**
 * Spawn the real runner with the production argv shape and capture the child's
 * stdio. Throws on spawn failure (ENOENT, or the spawnSync timeout expiring)
 * with the captured stderr so the failure names the actual boundary.
 */
function runConfined(mode: "read-only" | "workspace-write", args: readonly string[], overrides: RunOverrides = {}): ConfinedResult {
	const argv = [
		RUNNER,
		"--workspace",
		overrides.workspace ?? canonicalPath(workspace),
		"--temp",
		overrides.temp ?? canonicalPath(grantedTemp),
		"--mode",
		mode,
		"--",
		...args,
	];
	const result = spawnSync(process.execPath, argv, {
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT,
		windowsHide: true,
	});
	if (result.error !== undefined) {
		throw new Error(`failed to spawn the runner: ${result.error.message}\nstderr:\n${result.stderr ?? ""}`);
	}
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Both streams: `cmd` builtins may render their errors on stdout, not stderr. */
function denialText(result: ConfinedResult): string {
	return `${result.stderr}\n${result.stdout}`;
}

/**
 * Assert the confined child was denied: a windows-acl denial dialect in the
 * output (the dialects the TS classifier carries, Ruling 7) and — when the
 * command's failure path sets an exit code at all — a non-zero exit.
 */
function expectDenied(result: ConfinedResult, options: { requireNonZeroExit?: boolean } = {}): void {
	if (options.requireNonZeroExit ?? true) {
		expect(result.status, `expected a non-zero exit; output:\n${denialText(result)}`).not.toBe(0);
	}
	const lower = denialText(result).toLowerCase();
	const matched = DENIAL_SIGNATURES["windows-acl"].some((signature) => lower.includes(signature));
	expect(matched, `no windows-acl denial dialect in the output:\n${denialText(result)}`).toBe(true);
}

/** Assert a denied write/delete left nothing behind, cleaning up a leak first. */
function expectHostFileNotCreated(path: string): void {
	const leaked = existsSync(path);
	if (leaked) rmSync(path, { force: true });
	expect(leaked, `${path} must not exist after the confined command`).toBe(false);
}

function systemTempDir(): string {
	return join(process.env.SystemRoot ?? "C:\\Windows", "Temp");
}

/** pwsh when installed, Windows PowerShell 5.1 otherwise (spec §10.2 names both deny paths). */
function resolvePowerShell(): string {
	const pathDirs = (process.env.PATH ?? "").split(delimiter);
	for (const name of ["pwsh.exe", "powershell.exe"]) {
		for (const dir of pathDirs) {
			if (dir.length > 0 && existsSync(join(dir, name))) return join(dir, name);
		}
	}
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Grandchild probe run inside the confined child: one spawn with `stdio:'pipe'`
 * (creates anonymous pipes — the documented §4.6/§7 EPERM boundary) and one
 * with `stdio:'ignore'` (no pipe — must still work). The probe reports the raw
 * outcome; the test asserts the outcome, not Node's errno spelling.
 */
const GRANDCHILD_PROBE = `
const { spawnSync } = require("node:child_process");
const piped = spawnSync(process.execPath, ["-e", ""], { stdio: "pipe" });
const ignored = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
process.stdout.write(JSON.stringify({
	pipedStatus: piped.status,
	pipedErrorCode: piped.error ? piped.error.code : null,
	ignoredStatus: ignored.status,
	ignoredErrorCode: ignored.error ? ignored.error.code : null
}) + "\\n");
`;

// Fixtures are inside the Windows-only describe: the non-Windows bash-refusal
// case below must not touch the filesystem.
let root = "";
let workspace = "";
/** The privately granted temp root; the workspace is disjoint from it. */
let grantedTemp = "";

describe.skipIf(process.platform !== "win32")("windows-acl end-to-end (real runner)", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-sandbox-e2e-"));
		workspace = mkdtempSync(join(root, "workspace-"));
		grantedTemp = mkdtempSync(join(root, "granted-temp-"));
	});

	afterEach(() => {
		// Grants may have left Low labels and deny ACEs behind; the owning user
		// still holds DELETE on every object, so recursive cleanup is safe.
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("allows a workspace write under workspace-write", { timeout: E2E_TIMEOUT }, () => {
		const target = join(workspace, "child-created.txt");
		const result = runConfined(
			"workspace-write",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'ok'); console.log('written');", [target]),
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("written");
		expect(readFileSync(target, "utf8")).toBe("ok");
	});

	it("denies a write outside the granted roots", { timeout: E2E_TIMEOUT }, () => {
		const outsideDir = join(root, "outside");
		mkdirSync(outsideDir);
		const target = join(outsideDir, "denied.txt");
		const result = runConfined(
			"workspace-write",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'x')", [target]),
		);
		expectDenied(result);
		expectHostFileNotCreated(target);
	});

	const deleteOutsideCases: ReadonlyArray<{
		label: string;
		fileName: string;
		command: (victim: string) => string[];
		/** `cmd /c del` may leave ERRORLEVEL 0 even when the delete is denied. */
		failSetsExitCode: boolean;
	}> = [
		{
			label: "cmd /c del",
			fileName: "cmd-del.txt",
			command: (victim) => [process.env.ComSpec ?? "cmd.exe", "/c", "del", "/f", "/q", victim],
			failSetsExitCode: false,
		},
		{
			label: "powershell Remove-Item",
			fileName: "remove-item.txt",
			command: (victim) => [
				resolvePowerShell(),
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Remove-Item -LiteralPath ${psLiteral(victim)} -Force`,
			],
			failSetsExitCode: true,
		},
		{
			label: "PowerShell [System.IO.File]::Delete",
			fileName: "dotnet-delete.txt",
			command: (victim) => [
				resolvePowerShell(),
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`[System.IO.File]::Delete(${psLiteral(victim)})`,
			],
			failSetsExitCode: true,
		},
		{
			label: "Node fs.unlinkSync",
			fileName: "node-unlink.txt",
			command: (victim) => nodeScript("require('node:fs').unlinkSync(process.argv[1])", [victim]),
			failSetsExitCode: true,
		},
	];

	for (const { label, fileName, command, failSetsExitCode } of deleteOutsideCases) {
		it(`denies deleting a host file outside the workspace via ${label}`, { timeout: E2E_TIMEOUT }, () => {
			const outsideDir = join(root, "outside");
			mkdirSync(outsideDir, { recursive: true });
			const victim = join(outsideDir, fileName);
			writeFileSync(victim, "must-survive", "utf8");
			const result = runConfined("workspace-write", command(victim));
			expectDenied(result, { requireNonZeroExit: failSetsExitCode });
			// The host file must still be there: the denial is a real access
			// denial, not a "deleted then restored" path.
			expect(readFileSync(victim, "utf8")).toBe("must-survive");
		});
	}

	it("allows reading a system file outside the workspace", { timeout: E2E_TIMEOUT }, () => {
		const systemFile = join(process.env.SystemRoot ?? "C:\\Windows", "win.ini");
		const result = runConfined(
			"workspace-write",
			nodeScript("process.stdout.write(String(require('node:fs').readFileSync(process.argv[1], 'utf8').length));", [
				systemFile,
			]),
		);
		expect(result.status, result.stderr).toBe(0);
		expect(Number(result.stdout)).toBeGreaterThan(0);
	});

	for (const mode of ["read-only", "workspace-write"] as const) {
		it(`allows writing the NUL device in ${mode} mode`, { timeout: E2E_TIMEOUT }, () => {
			// Environment property (device DACL grants Everyone), not a sandbox grant:
			// it holds in both modes (design §7).
			const result = runConfined(
				mode,
				nodeScript("require('node:fs').writeFileSync('NUL', 'x'); console.log('nul-ok');"),
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("nul-ok");
		});
	}

	it("denies a workspace write under read-only", { timeout: E2E_TIMEOUT }, () => {
		const target = join(workspace, "read-only-denied.txt");
		const result = runConfined(
			"read-only",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'x')", [target]),
		);
		expectDenied(result);
		expectHostFileNotCreated(target);
	});

	it("allows a write under the granted %TEMP% root", { timeout: E2E_TIMEOUT }, () => {
		// The production seam grants canonicalPath(os.tmpdir()); the test root
		// lives under it, so this target is outside the workspace but inside the
		// granted temp root.
		const tempTargetDir = join(root, "temp-write-target");
		mkdirSync(tempTargetDir);
		const target = join(tempTargetDir, "temp-written.txt");
		const result = runConfined(
			"workspace-write",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'ok')", [target]),
			{ temp: canonicalPath(tmpdir()) },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("ok");
	});

	for (const exitCase of [
		{ label: "node process.exit(42)", argv: () => nodeScript("process.exit(42);"), expected: 42 },
		{ label: "cmd /c exit 7", argv: () => [process.env.ComSpec ?? "cmd.exe", "/c", "exit", "7"], expected: 7 },
	]) {
		it(`mirrors the child's exit code (${exitCase.label})`, { timeout: E2E_TIMEOUT }, () => {
			const result = runConfined("workspace-write", exitCase.argv());
			expect(result.status, result.stderr).toBe(exitCase.expected);
		});
	}

	it("mirrors a crashing child's full 32-bit status (0xC0000005)", { timeout: E2E_TIMEOUT }, () => {
		// A process that dies with STATUS_ACCESS_VIOLATION is observed by its
		// parent as exit code 0xC0000005. `ExitProcess` reproduces that exact
		// termination status deterministically (no WER dialog, no dump file).
		// Win32 exit codes are unsigned DWORDs: Node surfaces 0xC0000005 as the
		// unsigned 3221225477; -1073741819 is the signed int32 spelling of the
		// same bits. Assert the value as observed (unsigned hex here).
		const koffiEntry = createRequire(import.meta.url).resolve("koffi");
		const crashScript = `require(${JSON.stringify(koffiEntry)}).load("kernel32.dll").func("void ExitProcess(int)")(-1073741819);`;
		const result = runConfined("workspace-write", nodeScript(crashScript));
		expect(result.status, result.stderr).toBe(0xc0000005);
	});

	it("fails with exit 127 and the windows-acl-run signature when a root is missing", { timeout: E2E_TIMEOUT }, () => {
		const missingTempRoot = join(root, "missing-temp-root");
		const result = runConfined("workspace-write", nodeScript("process.exit(0);"), { temp: missingTempRoot });
		expect(result.status).toBe(127);
		expect(result.stdout).toBe("");
		const lines = result.stderr.split(/\r?\n/u).filter((line) => line.length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(RUNNER_SIGNATURE)).toBe(true);
		// The TS classifier must read exactly this line as a runner failure —
		// the command never ran — and never as a denial.
		expect(classifyRunnerFailure(result.status, result.stderr, RUNNER_FAILURE_RULES["windows-acl"])).toBe(lines[0]);
		expect(classifyDenial(result.status, result.stderr, DENIAL_SIGNATURES["windows-acl"])).toBe(false);
	});

	it("grants exactly the fence's writableRoots('workspace-write', workspace)", { timeout: E2E_TIMEOUT }, () => {
		const expected = writableRoots("workspace-write", workspace);
		// The production seam (runners.ts windowsAclRunnerArgv) is the construction
		// under test: --workspace is the canonical workspace and --temp is
		// canonicalPath(os.tmpdir()).
		const seamArgv = windowsAclRunnerArgv(
			{ mode: "workspace-write", workspaceRoot: canonicalPath(workspace) },
			{ node: process.execPath, runner: RUNNER },
		);
		const seamWorkspace = seamArgv[seamArgv.indexOf("--workspace") + 1];
		const seamTemp = seamArgv[seamArgv.indexOf("--temp") + 1];
		// Compare effective (canonical) roots, never the raw argv spelling.
		expect(new Set([canonicalPath(seamWorkspace), canonicalPath(seamTemp)])).toEqual(new Set(expected));

		// Effective proof: every expected root accepts a write from the confined
		// child (the workspace target is outside the granted temp; the temp target
		// is outside the workspace)...
		for (const target of [join(workspace, "agreement-ws-written.txt"), join(root, "agreement-temp-written.txt")]) {
			const result = runConfined(
				"workspace-write",
				nodeScript("require('node:fs').writeFileSync(process.argv[1], 'ok')", [target]),
				{ temp: seamTemp },
			);
			expect(result.status, `${target}: ${result.stderr}`).toBe(0);
			expect(readFileSync(target, "utf8")).toBe("ok");
		}
		// ...and a path outside all of them is denied.
		const outside = join(systemTempDir(), `pi-sandbox-e2e-agreement-${process.pid}-${Date.now()}.txt`);
		const denied = runConfined(
			"workspace-write",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'x')", [outside]),
			{ temp: seamTemp },
		);
		expectDenied(denied);
		expectHostFileNotCreated(outside);
	});

	it("denies a piped-stdio grandchild while ignore-stdio still spawns", { timeout: E2E_TIMEOUT }, () => {
		const probe = join(workspace, "piped-stdio-probe.cjs");
		writeFileSync(probe, GRANDCHILD_PROBE, "utf8");
		const result = runConfined("workspace-write", [process.execPath, probe]);
		expect(result.status, result.stderr).toBe(0);
		const line = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
		const report = JSON.parse(line) as {
			pipedStatus: number | null;
			pipedErrorCode: string | null;
			ignoredStatus: number | null;
			ignoredErrorCode: string | null;
		};
		// Documented `EPERM` boundary (design §4.6/§7): a grandchild with
		// `stdio:'pipe'` cannot create its anonymous pipes under the restricted
		// token. Node's errno spelling may vary, so assert the outcome — the
		// piped spawn did not succeed — not the error string.
		const pipedSpawned = report.pipedStatus === 0 && report.pipedErrorCode === null;
		expect(pipedSpawned, `piped-stdio grandchild unexpectedly spawned: ${line}`).toBe(false);
		expect(report.pipedErrorCode, `no error reported for the piped spawn: ${line}`).not.toBeNull();
		// Control: with `stdio:'ignore'` there is no pipe to create, so the
		// grandchild must also prove the boundary is the pipe, not a broken spawn.
		expect(report.ignoredErrorCode, `ignore-stdio grandchild failed: ${line}`).toBeNull();
		expect(report.ignoredStatus).toBe(0);
	});
});

/**
 * Runs everywhere: `assertShellAllowed` is a pure function of the injected
 * platform, and the refusal contract (fail-closed, settings snippet, pi
 * version premise) is part of spec §10.2. Kept here rather than only in
 * tests/confine.test.ts so the §10.2 mapping is complete in one file.
 */
describe("windows-acl bash refusal (TypeScript layer, all platforms)", () => {
	it("refuses bash in both win32 confined modes with the settings snippet", () => {
		expect(() => assertShellAllowed("bash", "win32", "workspace-write")).toThrowError(UnsupportedWindowsShellError);
		expect(() => assertShellAllowed("bash", "win32", "read-only")).toThrowError(UnsupportedWindowsShellError);
		let message = "";
		try {
			assertShellAllowed("bash", "win32", "workspace-write");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('{ "defaultTools": ["-bash", "+powershell"] }');
		expect(message).toContain("requires pi >= 1.0.0");
		// danger-full-access is the documented escape hatch; other platforms and
		// the powershell shell are unaffected.
		expect(() => assertShellAllowed("bash", "win32", "danger-full-access")).not.toThrow();
		expect(() => assertShellAllowed("bash", "linux", "workspace-write")).not.toThrow();
		expect(() => assertShellAllowed("powershell", "win32", "workspace-write")).not.toThrow();
	});
});
