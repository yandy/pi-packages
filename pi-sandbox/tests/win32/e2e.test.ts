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
 *  - Fixtures live under `os.homedir()`, never under `os.tmpdir()`: two cases
 *    grant the REAL `%TEMP%` as `--temp`, and that grant is inheritable and
 *    standing (design §4.7), so a fixture planted under `%TEMP%` would inherit
 *    the capability ACE on the next run and flip the denial cases green for the
 *    wrong reason. `assertFixtureRootOutsideTmpdir` turns that into a loud
 *    failure instead of a silent green.
 *  - Denial evidence is split: the non-zero exit and the host file's state
 *    (survival / non-creation) are the locale-independent proof of the
 *    boundary; the English-only denial dialects are asserted separately
 *    (`expectDenialDialect`) and only where the text comes from Node's own
 *    errno layer. On a localized Windows the `cmd`/PowerShell/.NET messages are
 *    localized — a classification gap, not a boundary gap; the acceptance
 *    checklist records it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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
 * Assert the confined child was denied at the boundary: it reported failure
 * (when the command's failure path sets an exit code at all) and the failure
 * is NOT the runner itself.
 *
 * The runner-failure guard is load-bearing: a broken runner fails with
 * `windows-acl-run: Win32 <API> failed (5): Access is denied. …`, whose
 * FormatMessageW text is itself one of the denial dialects on an English host.
 * Without the guard such a run would satisfy a dialect search while the child
 * never executed.
 *
 * This deliberately carries no dialect assertion: the dialect text is
 * locale-coupled (see `expectDenialDialect`), while the exit status is the
 * locale-independent half of the evidence. The host-side file state — survival
 * on a delete, non-creation on a write — is the other half and stays with each
 * case.
 */
function expectDenied(result: ConfinedResult, options: { requireNonZeroExit?: boolean } = {}): void {
	if (options.requireNonZeroExit ?? true) {
		expect(result.status, `expected a non-zero exit; output:\n${denialText(result)}`).not.toBe(0);
	}
	const fatal = classifyRunnerFailure(result.status, result.stderr, RUNNER_FAILURE_RULES["windows-acl"]);
	expect(
		fatal,
		`runner failed before the command ran — a runner failure is never a denial; output:\n${denialText(result)}`,
	).toBeUndefined();
}

/** First denial dialect present in `stderr` — the stream production classifies. */
function matchedDenialSignature(result: ConfinedResult): string | undefined {
	const lower = result.stderr.toLowerCase();
	return DENIAL_SIGNATURES["windows-acl"].find((signature) => lower.includes(signature));
}

/**
 * Assert production's `classifyDenial` would recognize this failure: a
 * windows-acl dialect (Ruling 7) in STDERR — stderr only, like
 * `src/confine.ts`. A `cmd` builtin can print its denial on stdout, which
 * production does not classify (recorded in the acceptance checklist §7).
 *
 * Called only where the text comes from Node's own errno layer (`EPERM:
 * operation not permitted`), which is English on every locale. The
 * `cmd`/PowerShell/.NET deny paths assert the locale-independent boundary
 * evidence instead (non-zero exit + host file survival): their message text is
 * localized on a localized Windows, where the sandbox still denies but the
 * tool cannot annotate the denial.
 */
function expectDenialDialect(result: ConfinedResult): void {
	expect(matchedDenialSignature(result), `no windows-acl denial dialect in stderr:\n${denialText(result)}`).toBeDefined();
}

/** Assert a denied write/delete left nothing behind, cleaning up a leak first. */
function expectHostFileNotCreated(path: string): void {
	const leaked = existsSync(path);
	if (leaked) rmSync(path, { force: true });
	expect(leaked, `${path} must not exist after the confined command`).toBe(false);
}

/**
 * Base directory for every filesystem fixture: a per-run directory under the
 * user home — deliberately NOT under `os.tmpdir()`.
 *
 * Two cases grant the REAL `%TEMP%` as `--temp`; the runner's grant is
 * inheritable and standing (design §4.7; never revoked). A fixture planted
 * under `%TEMP%` on a second run would inherit that capability ACE through the
 * temp root and become writable by the confined child: the "outside" denial
 * cases would then fail on a machine whose confinement works, and the
 * workspace-allow cases could pass for the wrong reason.
 * `assertFixtureRootOutsideTmpdir` makes that invariant a hard failure.
 */
function fixtureBaseDir(): string {
	return homedir();
}

/** Windows paths fold case; children are matched on a separator boundary. */
function isPathInside(candidate: string, ancestor: string): boolean {
	const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
	const child = fold(canonicalPath(candidate)).replace(/[\\/]+$/u, "");
	const parent = fold(canonicalPath(ancestor)).replace(/[\\/]+$/u, "");
	return child === parent || child.startsWith(`${parent}\\`) || child.startsWith(`${parent}/`);
}

/** Fail loudly when a fixture root would sit inside a granted temp root. */
function assertFixtureRootOutsideTmpdir(path: string): void {
	if (isPathInside(path, tmpdir())) {
		throw new Error(
			`fixture root ${path} is inside os.tmpdir() (${tmpdir()}): the suite grants the real %TEMP%, ` +
				"whose inheritable ACE would leak into the fixture on a re-run",
		);
	}
}

/**
 * The only fixtures that must sit inside the real granted temp root: the
 * `%TEMP%` grant case and the fence-agreement case. Each is created directly
 * under `os.tmpdir()` and removed by `afterEach` (the owning user keeps DELETE
 * on its own objects even after the standing grant).
 */
const realTempFixtures: string[] = [];

function makeRealTempFixture(): string {
	const dir = mkdtempSync(join(canonicalPath(tmpdir()), "pi-sandbox-e2e-temp-"));
	realTempFixtures.push(dir);
	return dir;
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
		// The fixture root must be outside the real `%TEMP%` (see fixtureBaseDir):
		// assert it loudly rather than let a re-run inherit the standing temp
		// grant and misread a working confinement.
		root = mkdtempSync(join(fixtureBaseDir(), "pi-sandbox-e2e-"));
		try {
			assertFixtureRootOutsideTmpdir(root);
		} catch (error) {
			// The assertion is a safety net; do not leak the fixture it rejected.
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
		workspace = mkdtempSync(join(root, "workspace-"));
		grantedTemp = mkdtempSync(join(root, "granted-temp-"));
	});

	afterEach(() => {
		// Grants may have left Low labels and deny ACEs behind; the owning user
		// still holds DELETE on every object, so recursive cleanup is safe.
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		while (realTempFixtures.length > 0) {
			const fixture = realTempFixtures.pop();
			if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
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
		expectDenialDialect(result);
		expectHostFileNotCreated(target);
	});

	/** `dialect: "localized"` cases carry OS/CLR message text; only `node` text is English on every locale. */
	const deleteOutsideCases: ReadonlyArray<{
		label: string;
		fileName: string;
		command: (victim: string) => string[];
		/** `cmd /c del` may leave ERRORLEVEL 0 even when the delete is denied. */
		failSetsExitCode: boolean;
		dialect: "node" | "localized";
	}> = [
		{
			label: "cmd /c del",
			fileName: "cmd-del.txt",
			command: (victim) => [process.env.ComSpec ?? "cmd.exe", "/c", "del", "/f", "/q", victim],
			failSetsExitCode: false,
			dialect: "localized",
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
			dialect: "localized",
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
			dialect: "localized",
		},
		{
			label: "Node fs.unlinkSync",
			fileName: "node-unlink.txt",
			command: (victim) => nodeScript("require('node:fs').unlinkSync(process.argv[1])", [victim]),
			failSetsExitCode: true,
			dialect: "node",
		},
	];

	for (const { label, fileName, command, failSetsExitCode, dialect } of deleteOutsideCases) {
		it(`denies deleting a host file outside the workspace via ${label}`, { timeout: E2E_TIMEOUT }, () => {
			const outsideDir = join(root, "outside");
			mkdirSync(outsideDir, { recursive: true });
			const victim = join(outsideDir, fileName);
			writeFileSync(victim, "must-survive", "utf8");
			const result = runConfined("workspace-write", command(victim));
			// Primary, locale-independent evidence: the child failed where the
			// command sets an exit code, and the host file survived. The denial is
			// a real access denial, not a "deleted then restored" path.
			expectDenied(result, { requireNonZeroExit: failSetsExitCode });
			expect(readFileSync(victim, "utf8")).toBe("must-survive");
			// The dialect is required only where the text is Node's own (English on
			// every locale). `cmd`/PowerShell/.NET localize theirs: on a localized
			// Windows a missing dialect is an expected deviation (checklist §0/§7),
			// not a confinement failure — the host file above still proves the
			// boundary.
			if (dialect === "node") expectDenialDialect(result);
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
		expectDenialDialect(result);
		expectHostFileNotCreated(target);
	});

	it("allows a write under the granted %TEMP% root", { timeout: E2E_TIMEOUT }, () => {
		// The production seam grants canonicalPath(os.tmpdir()); this is the one
		// fixture that must live inside it, so it is created directly under the
		// real temp root (and cleaned up by afterEach) instead of under `root`.
		const target = join(makeRealTempFixture(), "temp-written.txt");
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

	it("classifies a Win32-backed runner failure as a runner failure, not a denial", { timeout: E2E_TIMEOUT }, () => {
		// A directory as the wrapped command: both roots pass `requireDirectory`,
		// then CreateProcessAsUserW fails with ERROR_ACCESS_DENIED (5) — a real
		// Win32 API failure, not argv validation. The API name and code are not
		// localized; on an English host the FormatMessageW text is "Access is
		// denied.", itself a denial dialect — the overlap this case guards.
		const directoryAsCommand = mkdtempSync(join(root, "not-an-executable-"));
		const result = runConfined("workspace-write", [directoryAsCommand]);
		expect(result.status).toBe(127);
		expect(result.stdout).toBe("");
		const lines = result.stderr.split(/\r?\n/u).filter((line) => line.length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(RUNNER_SIGNATURE)).toBe(true);
		expect(lines[0]).toContain("Win32 CreateProcessAsUserW failed (5)");
		// The command never ran. Production checks runner failures before
		// denials; `expectDenied` must refuse this even though the text carries a
		// dialect on an English host. The forged companion case in the
		// all-platform describe pins that overlap independently of the locale.
		expect(classifyRunnerFailure(result.status, result.stderr, RUNNER_FAILURE_RULES["windows-acl"])).toBe(lines[0]);
		expect(() => expectDenied(result)).toThrowError(/runner failure is never a denial/u);
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
		// is outside the workspace and inside the real %TEMP%).
		const tempTarget = join(makeRealTempFixture(), "agreement-temp-written.txt");
		for (const target of [join(workspace, "agreement-ws-written.txt"), tempTarget]) {
			const result = runConfined(
				"workspace-write",
				nodeScript("require('node:fs').writeFileSync(process.argv[1], 'ok')", [target]),
				{ temp: seamTemp },
			);
			expect(result.status, `${target}: ${result.stderr}`).toBe(0);
			expect(readFileSync(target, "utf8")).toBe("ok");
		}
		// ...and a path outside all of them is denied. `root` is the closest
		// possible outside path (the fixture parent of the workspace) and, unlike
		// C:\Windows\Temp, it is writable by the unconfined host even when the
		// suite runs elevated: the denial can only come from the sandbox.
		const outside = join(root, "agreement-outside.txt");
		const denied = runConfined(
			"workspace-write",
			nodeScript("require('node:fs').writeFileSync(process.argv[1], 'x')", [outside]),
			{ temp: seamTemp },
		);
		expectDenied(denied);
		expectDenialDialect(denied);
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
 * Runs everywhere: guards the assertion helper itself. The Windows-only case
 * proves the overlap with a real Win32 failure; this forged one pins it on
 * every platform and on hosts whose messages are localized (where the real
 * failure's text carries no dialect at all).
 */
describe("windows-acl denial assertion guard (all platforms)", () => {
	it("refuses a runner failure whose Win32 message carries a denial dialect", () => {
		const forged: ConfinedResult = {
			status: 127,
			stdout: "",
			stderr: `${RUNNER_SIGNATURE}Win32 CreateProcessAsUserW failed (5): Access is denied. [command: C:\\nope, cwd: C:\\nope]\n`,
		};
		expect(() => expectDenied(forged)).toThrowError(/runner failure is never a denial/u);
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
