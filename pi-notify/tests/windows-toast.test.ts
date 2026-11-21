import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const itOnWindows = process.platform === "win32" ? it : it.skip;
// PowerShell cold start on a Windows runner regularly needs more than the vitest
// default of 5s, so the outer limit stays well above the spawn timeout.
const WINDOWS_TIMEOUT = 60_000;
const scriptPath = fileURLToPath(new URL("../src/windows-toast.ps1", import.meta.url));

function runScript(args: string[]) {
	return spawnSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			...args,
		],
		{
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		},
	);
}

itOnWindows(
	"windows-toast.ps1 has valid PowerShell syntax",
	() => {
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[void][scriptblock]::Create([IO.File]::ReadAllText($env:PI_NOTIFY_TEST_SCRIPT))",
			],
			{
				encoding: "utf8",
				env: { ...process.env, PI_NOTIFY_TEST_SCRIPT: scriptPath },
				timeout: 30_000,
				windowsHide: true,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	},
	WINDOWS_TIMEOUT,
);

// A syntax check cannot catch the class of bug this covers: the script used to
// enumerate a live WinRT node list after mutating it and threw at runtime, while
// passing every parse-only assertion.
itOnWindows(
	"windows-toast.ps1 -DryRun builds escaped toast XML instead of showing it",
	() => {
		const result = runScript([
			"-Title",
			"A & B <c>",
			"-Body",
			"line one\u0007\nline two\nline three",
			"-Urgency",
			"critical",
			"-DryRun",
		]);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('duration="long"');
		expect(result.stdout).toContain("<text>A &amp; B &lt;c&gt;</text>");
		expect(result.stdout).toContain("<text>line one</text>");
		// The body is split at the first newline only, so any further lines stay in the
		// second field. The BEL in the first line is stripped as an invalid XML 1.0
		// character.
		expect(result.stdout).toMatch(/<text>line two\s+line three<\/text>/);
		expect(result.stdout).not.toContain("\u0007");
	},
	WINDOWS_TIMEOUT,
);

itOnWindows(
	"windows-toast.ps1 -DryRun uses the short duration for non-critical urgency",
	() => {
		const result = runScript(["-Title", "T", "-Body", "B", "-Urgency", "normal", "-DryRun"]);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('duration="short"');
		expect(result.stdout).toContain("<text>T</text>");
		expect(result.stdout).toContain("<text>B</text>");
	},
	WINDOWS_TIMEOUT,
);
