import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { expandEnvEntry } from "../src/runtime";

describe("expandEnvEntry", () => {
	it("passes through plain values unchanged", () => {
		const result = expandEnvEntry("NODE_ENV=production", "/tmp");
		expect(result).toBe("NODE_ENV=production");
	});

	it("expands shell command substitution with $(...)", () => {
		const tmpFile = `/tmp/pi-test-env-expand-${Date.now()}`;
		execSync(`echo -n "secret-token" > "${tmpFile}"`);
		try {
			const result = expandEnvEntry(`TOKEN=$(cat "${tmpFile}")`, "/tmp");
			expect(result).toBe("TOKEN=secret-token");
		} finally {
			execSync(`rm -f "${tmpFile}"`);
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

describe("env merge order", () => {
	it("builtin env comes before user env, user can override", () => {
		const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
		const userEnv = ["DEBIAN_FRONTEND=dialog", "CUSTOM=val"];
		const expanded = userEnv.map((e) => expandEnvEntry(e, "/tmp"));
		const merged = [...builtinEnv, ...expanded];
		// Docker uses the LAST occurrence for dup keys, so user's override wins
		expect(merged).toEqual([
			"DEBIAN_FRONTEND=noninteractive",
			"DEBIAN_FRONTEND=dialog",
			"CUSTOM=val",
		]);
	});

	it("when env is undefined, use builtin only", () => {
		const builtinEnv = ["DEBIAN_FRONTEND=noninteractive"];
		const userEnv: string[] | undefined = undefined;
		const env = [
			...builtinEnv,
			...(userEnv ?? []).map((e) => expandEnvEntry(e, "/tmp")),
		];
		expect(env).toEqual(["DEBIAN_FRONTEND=noninteractive"]);
	});
});
