import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const itOnWindows = process.platform === "win32" ? it : it.skip;

itOnWindows("windows-toast.ps1 has valid PowerShell syntax", () => {
	const scriptPath = fileURLToPath(new URL("../src/windows-toast.ps1", import.meta.url));
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
			timeout: 10000,
			windowsHide: true,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
});
