// pi-sandbox/tests/win32-cli.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, requireDirectory, RUNNER_FAILURE_EXIT, RUNNER_SIGNATURE } from "../src/win32/cli.js";

const base = ["--workspace", "C:\\ws", "--temp", "C:\\tmp", "--mode", "workspace-write", "--", "pwsh.exe", "-Command", "echo hi"];

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined });

describe("win32 runner cli", () => {
	it("parses the documented contract", () => {
		expect(parseArgs(base)).toEqual({
			workspace: "C:\\ws",
			temp: "C:\\tmp",
			mode: "workspace-write",
			command: "pwsh.exe",
			args: ["-Command", "echo hi"],
		});
	});

	it("keeps the command argv verbatim after the separator", () => {
		const parsed = parseArgs([...base.slice(0, 6), "--", "pwsh.exe", "-Command", "echo --workspace x"]);
		expect(parsed.args).toEqual(["-Command", "echo --workspace x"]);
	});

	it("rejects missing, unknown, and duplicated args", () => {
		expect(() => parseArgs(["--temp", "C:\\tmp", "--mode", "read-only", "--", "pwsh.exe"])).toThrowError(/missing --workspace/);
		expect(() => parseArgs(["--workspace"])).toThrowError(/missing value after --workspace/);
		expect(() => parseArgs([...base.slice(0, 6), "--oops", "--", "pwsh.exe"])).toThrowError(/unknown argument: --oops/);
		expect(() => parseArgs([...base.slice(0, 6), "--write-sid", "S-1-4-1-1", "--", "pwsh.exe"])).toThrowError(/unknown argument: --write-sid/);
	});

	it("rejects unknown modes and a missing command", () => {
		expect(() => parseArgs(["--workspace", "C:\\ws", "--temp", "C:\\tmp", "--mode", "danger-full-access", "--", "pwsh.exe"]))
			.toThrowError(/unknown mode: danger-full-access/);
		expect(() => parseArgs(["--workspace", "C:\\ws", "--temp", "C:\\tmp", "--mode", "read-only", "--"]))
			.toThrowError(/missing command after --/);
	});

	it("validates that both roots exist as directories", () => {
		dir = mkdtempSync(join(tmpdir(), "sbx-cli-"));
		expect(() => requireDirectory("--workspace", join(dir, "nope"))).toThrowError(/--workspace is not an existing directory/);
		const file = join(dir, "file.txt");
		writeFileSync(file, "x");
		expect(() => requireDirectory("--temp", file)).toThrowError(/--temp is not an existing directory/);
		expect(() => requireDirectory("--workspace", dir)).not.toThrow();
	});

	it("exposes the documented failure contract", () => {
		expect(RUNNER_SIGNATURE).toBe("windows-acl-run");
		expect(RUNNER_FAILURE_EXIT).toBe(127);
	});
});
