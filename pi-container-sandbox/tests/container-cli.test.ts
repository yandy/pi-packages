import { describe, expect, it } from "vitest";
import { container, containerSpawn } from "../src/container-cli";

describe("container", () => {
	it("calls echo via container()", () => {
		const result = container("echo", ["-n", "hello"]);
		expect(result).toBe("hello");
	});

	it("calls echo via containerSpawn()", async () => {
		const result = await containerSpawn("echo", ["-n", "world"], {});
		expect(result.stdout.toString()).toBe("world");
		expect(result.exitCode).toBe(0);
	});

	it("throws when binary not found", () => {
		expect(() => container("nonexistent-binary-xyz", ["--help"])).toThrow();
	});

	it("captures stderr separately", async () => {
		// sh -c 'echo err >&2' writes to stderr
		const result = await containerSpawn("sh", ["-c", "echo err >&2"], {});
		expect(result.stderr.toString().trim()).toBe("err");
	});
});
