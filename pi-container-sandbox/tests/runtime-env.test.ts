import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandEnvEntry } from "../src/runtime";

describe("expandEnvEntry", () => {
	it("passes through plain values unchanged", () => {
		const result = expandEnvEntry("NODE_ENV=production", "/tmp");
		expect(result).toBe("NODE_ENV=production");
	});

	it("expands shell command substitution with $(...)", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-test-env-expand-"));
		const tmpFile = join(tmpDir, "token.txt");
		try {
			execSync(`echo -n "secret-token" > "${tmpFile}"`);
			const result = expandEnvEntry(`TOKEN=$(cat "${tmpFile}")`, "/tmp");
			expect(result).toBe("TOKEN=secret-token");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("expands $HOME variable reference", () => {
		const home = process.env.HOME || "/home/user";
		const result = expandEnvEntry("HOME_DIR=$HOME", "/tmp");
		expect(result).toBe(`HOME_DIR=${home}`);
	});

	it("produces empty string when substitution yields nothing", () => {
		const result = expandEnvEntry("KEY=$(nonexistent-command 2>/dev/null)", "/tmp");
		expect(result).toBe("KEY=");
	});

	it("handles values with single quotes by escaping them", () => {
		const result = expandEnvEntry("MSG=it's working", "/tmp");
		expect(result).toBe("MSG=it's working");
	});

	it("preserves key=value format with multiple equals signs", () => {
		const result = expandEnvEntry("URL=https://example.com?a=1&b=2", "/tmp");
		expect(result).toBe("URL=https://example.com?a=1&b=2");
	});
});
