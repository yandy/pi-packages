import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsDirs, type SettingsDirs } from "../helpers/tmp-settings-dirs";

describe("createSettingsDirs", () => {
	let dirs: SettingsDirs;

	beforeEach(() => {
		dirs = createSettingsDirs("config.json");
	});

	afterEach(() => {
		dirs.dispose();
	});

	it("creates two distinct existing tmp directories", () => {
		expect(existsSync(dirs.globalDir)).toBe(true);
		expect(existsSync(dirs.projectDir)).toBe(true);
		expect(dirs.globalDir).not.toBe(dirs.projectDir);
	});

	it("resolves the global file as <globalDir>/<filename>", () => {
		expect(dirs.globalFile()).toBe(join(dirs.globalDir, "config.json"));
	});

	it("resolves the project file as <projectDir>/.pi/<filename>", () => {
		expect(dirs.projectFile()).toBe(join(dirs.projectDir, ".pi", "config.json"));
	});

	it("writeGlobal lands JSON at the global file", () => {
		dirs.writeGlobal({ name: "global" });
		expect(JSON.parse(readFileSync(dirs.globalFile(), "utf-8"))).toEqual({ name: "global" });
	});

	it("writeProject creates <projectDir>/.pi/ and lands JSON at the project file", () => {
		expect(existsSync(join(dirs.projectDir, ".pi"))).toBe(false);
		dirs.writeProject({ name: "project" });
		expect(JSON.parse(readFileSync(dirs.projectFile(), "utf-8"))).toEqual({ name: "project" });
	});

	it("dispose removes both tmp directories", () => {
		dirs.writeGlobal({ name: "global" });
		dirs.writeProject({ name: "project" });
		dirs.dispose();
		expect(existsSync(dirs.globalDir)).toBe(false);
		expect(existsSync(dirs.projectDir)).toBe(false);
	});
});
