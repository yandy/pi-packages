import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RETENTION_POLICY,
	loadRetentionPolicy,
	parseRetentionPolicy,
	retentionConfigPath,
} from "../src/retention-config.js";

const defaults = { retentionDays: 30, maxRefs: 1000 };

let agentDir: string;
let projectDir: string | undefined;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-agent-"));
	projectDir = undefined;
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(agentDir, { recursive: true, force: true });
	if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

async function writeConfig(contents: string): Promise<void> {
	await writeFile(join(agentDir, "checkpoint.json"), contents, "utf8");
}

/** Returns the thrown error so the message itself can be asserted. */
function errorFrom(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to throw");
}

describe("parseRetentionPolicy", () => {
	it("defaults both dimensions when no fields are configured", () => {
		expect(parseRetentionPolicy({})).toEqual(defaults);
	});

	it("accepts the default values when configured explicitly", () => {
		expect(parseRetentionPolicy({ retentionDays: 30, maxRefs: 1000 })).toEqual(defaults);
	});

	it("resolves each dimension independently", () => {
		expect(parseRetentionPolicy({ retentionDays: 7 })).toEqual({ retentionDays: 7, maxRefs: 1000 });
		expect(parseRetentionPolicy({ maxRefs: 5 })).toEqual({ retentionDays: 30, maxRefs: 5 });
	});

	it("accepts null to disable a dimension", () => {
		expect(parseRetentionPolicy({ retentionDays: null })).toEqual({ retentionDays: null, maxRefs: 1000 });
		expect(parseRetentionPolicy({ maxRefs: null })).toEqual({ retentionDays: 30, maxRefs: null });
		expect(parseRetentionPolicy({ retentionDays: null, maxRefs: null })).toEqual({
			retentionDays: null,
			maxRefs: null,
		});
	});

	it("accepts 1 as the smallest positive integer", () => {
		expect(parseRetentionPolicy({ retentionDays: 1, maxRefs: 1 })).toEqual({ retentionDays: 1, maxRefs: 1 });
	});

	it.each(["retentionDays", "maxRefs"] as const)("rejects invalid %s values", (field) => {
		const invalidValues: unknown[] = [0, -1, -30, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e100, "30", true, [], {}];
		for (const value of invalidValues) {
			const error = errorFrom(() => parseRetentionPolicy({ [field]: value }));
			expect(error.message).toContain(`${field} must be a positive integer or null`);
		}
	});

	it.each([null, undefined, [], "checkpoint.json", 42, true])("rejects non-object config payload %s", (raw) => {
		expect(() => parseRetentionPolicy(raw)).toThrow(/must be a JSON object/);
	});

	it("does not echo the offending value in the error message", () => {
		const error = errorFrom(() => parseRetentionPolicy({ retentionDays: "SENTINEL-VALUE" }));
		expect(error.message).not.toContain("SENTINEL-VALUE");
	});
});

describe("loadRetentionPolicy", () => {
	it("uses the documented defaults when the config file is missing", async () => {
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual(defaults);
		expect(DEFAULT_RETENTION_POLICY).toEqual(defaults);
	});

	it("reads exactly <agentDir>/checkpoint.json", async () => {
		expect(retentionConfigPath(agentDir)).toBe(join(agentDir, "checkpoint.json"));
		await writeConfig(JSON.stringify({ retentionDays: 30, maxRefs: 1000 }));
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual(defaults);
	});

	it("loads independent positive integers and null values", async () => {
		await writeConfig(JSON.stringify({ retentionDays: 3 }));
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual({ retentionDays: 3, maxRefs: 1000 });

		await writeConfig(JSON.stringify({ retentionDays: null, maxRefs: 12 }));
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual({ retentionDays: null, maxRefs: 12 });

		await writeConfig(JSON.stringify({ retentionDays: null, maxRefs: null }));
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual({ retentionDays: null, maxRefs: null });
	});

	it("ignores project-level config", async () => {
		projectDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-project-"));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "checkpoint.json"), JSON.stringify({ retentionDays: 1, maxRefs: 1 }));
		const previousCwd = process.cwd();
		process.chdir(projectDir);
		try {
			await expect(loadRetentionPolicy(agentDir)).resolves.toEqual(defaults);
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("rejects malformed JSON without leaking file contents", async () => {
		await writeConfig('{"retentionDays": 30, "SENTINEL-CONTENT":');
		const error = await loadRetentionPolicy(agentDir).then(
			() => {
				throw new Error("expected loadRetentionPolicy to reject");
			},
			(thrown: Error) => thrown,
		);
		expect(error.message).toContain(retentionConfigPath(agentDir));
		expect(error.message).not.toContain("SENTINEL-CONTENT");
	});

	it("rejects invalid field values without leaking file contents", async () => {
		await writeConfig(JSON.stringify({ retentionDays: 0, maxRefs: "SENTINEL-CONTENT" }));
		const error = await loadRetentionPolicy(agentDir).then(
			() => {
				throw new Error("expected loadRetentionPolicy to reject");
			},
			(thrown: Error) => thrown,
		);
		expect(error.message).toContain("retentionDays must be a positive integer or null");
		expect(error.message).not.toContain("SENTINEL-CONTENT");
	});

	it("rejects non-object JSON payloads instead of falling back to defaults", async () => {
		for (const contents of ["null", "[]", '"checkpoint.json"', "42"]) {
			await writeConfig(contents);
			await expect(loadRetentionPolicy(agentDir)).rejects.toThrow(/must be a JSON object/);
		}
	});

	it("fails on non-ENOENT read errors instead of using defaults", async () => {
		await mkdir(join(agentDir, "checkpoint.json"));
		const error = await loadRetentionPolicy(agentDir).then(
			() => {
				throw new Error("expected loadRetentionPolicy to reject");
			},
			(thrown: Error) => thrown,
		);
		expect(error.message).toContain("Unable to read checkpoint config");
		expect(error.message).toContain(retentionConfigPath(agentDir));
	});

	it("defaults the agent directory to getAgentDir()", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		await expect(loadRetentionPolicy()).resolves.toEqual(defaults);

		await writeConfig(JSON.stringify({ retentionDays: 4, maxRefs: 40 }));
		await expect(loadRetentionPolicy()).resolves.toEqual({ retentionDays: 4, maxRefs: 40 });
	});

	it("returns fresh policy objects that cannot mutate the defaults", async () => {
		const policy = await loadRetentionPolicy(agentDir);
		policy.retentionDays = 1;
		policy.maxRefs = 1;
		await expect(loadRetentionPolicy(agentDir)).resolves.toEqual(defaults);
		expect(DEFAULT_RETENTION_POLICY).toEqual(defaults);
	});
});
