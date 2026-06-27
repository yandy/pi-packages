import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLayeredSettings } from "../src/layered-settings";
import { captureWarn } from "./helpers/capture-warn";
import { createSettingsDirs, type SettingsDirs } from "./helpers/tmp-settings-dirs";

interface TestConfig {
	name?: string;
	count?: number;
}

function sanitize(raw: unknown): Partial<TestConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<TestConfig> = {};
	if (typeof r.name === "string") out.name = r.name;
	if (typeof r.count === "number") out.count = r.count;
	return out;
}

describe("loadLayeredSettings", () => {
	const FILENAME = "test-settings.json";

	let dirs: SettingsDirs;
	let agentDir: string;
	let cwd: string;
	let globalFile: () => string;
	let projectFile: () => string;
	let writeGlobal: (obj: unknown) => void;
	let writeProject: (obj: unknown) => void;

	beforeEach(() => {
		dirs = createSettingsDirs(FILENAME);
		({ globalDir: agentDir, projectDir: cwd, globalFile, projectFile, writeGlobal, writeProject } = dirs);
	});

	afterEach(() => {
		dirs.dispose();
	});

	function load() {
		return loadLayeredSettings<TestConfig>({ agentDir, cwd, filename: FILENAME, sanitize, warnLabel: "test-pkg" });
	}

	describe("missing files", () => {
		it("returns {} when both files are absent", () => {
			expect(load()).toEqual({});
		});

		it("does not warn when files are simply missing", () => {
			expect(captureWarn(() => load())).toEqual([]);
		});
	});

	describe("single-layer loading", () => {
		it("loads from global when no project file", () => {
			writeGlobal({ name: "global", count: 10 });
			expect(load()).toEqual({ name: "global", count: 10 });
		});

		it("loads from project when no global file", () => {
			writeProject({ name: "project" });
			expect(load()).toEqual({ name: "project" });
		});
	});

	describe("project overrides global", () => {
		it("merges global + project with project winning on conflicts", () => {
			writeGlobal({ name: "global", count: 10 });
			writeProject({ name: "project", count: 20 });
			expect(load()).toEqual({ name: "project", count: 20 });
		});

		it("keeps global keys not overridden by project", () => {
			writeGlobal({ name: "global", count: 10 });
			writeProject({ count: 99 });
			expect(load()).toEqual({ name: "global", count: 99 });
		});
	});

	describe("sanitize applied to parsed JSON", () => {
		it("passes parsed JSON through sanitize", () => {
			writeGlobal({ name: "valid", extraField: "ignored" });
			expect(load()).toEqual({ name: "valid" });
		});

		it("returns {} when global file contains valid JSON but fails sanitize", () => {
			writeGlobal({ unrecognised: true });
			expect(load()).toEqual({});
		});
	});

	describe("custom filename", () => {
		it("resolves global file as <agentDir>/<filename>", () => {
			// Only the global file exists — proves path is <agentDir>/test-settings.json
			writeGlobal({ count: 7 });
			expect(load()).toEqual({ count: 7 });
		});

		it("resolves project file as <cwd>/.pi/<filename>", () => {
			// Only the project file exists — proves path is <cwd>/.pi/test-settings.json
			writeProject({ count: 42 });
			expect(load()).toEqual({ count: 42 });
		});
	});

	describe("malformed files", () => {
		it.each([
			{ layer: "global", writeMalformed: () => writeFileSync(globalFile(), "not valid {{{{") },
			{
				layer: "project",
				writeMalformed: () => {
					mkdirSync(join(cwd, ".pi"), { recursive: true });
					writeFileSync(projectFile(), "also invalid {{{");
				},
			},
		])("returns {} and warns when the $layer file is malformed JSON", ({ writeMalformed }) => {
			writeMalformed();
			const warnings = captureWarn(() => {
				expect(load()).toEqual({});
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/\[test-pkg\]/);
			expect(warnings[0]).toMatch(/Ignoring malformed settings/);
		});

		it("warns once per bad file (two malformed files → two warnings)", () => {
			writeFileSync(globalFile(), "bad1");
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(projectFile(), "bad2");
			const warnings = captureWarn(() => {
				expect(load()).toEqual({});
			});
			expect(warnings).toHaveLength(2);
		});

		it("uses global when project file is malformed (global is valid)", () => {
			writeGlobal({ name: "global" });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(projectFile(), "invalid");
			captureWarn(() => {
				expect(load()).toEqual({ name: "global" });
			});
		});
	});

	describe("warnLabel used in warning message", () => {
		it("includes warnLabel in the warning prefix", () => {
			writeFileSync(globalFile(), "bad");
			const warnings = captureWarn(() => {
				loadLayeredSettings<TestConfig>({
					agentDir,
					cwd,
					filename: FILENAME,
					sanitize,
					warnLabel: "my-custom-pkg",
				});
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/\[my-custom-pkg\]/);
		});
	});
});
