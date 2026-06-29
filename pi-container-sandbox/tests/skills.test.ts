import { describe, expect, it } from "vitest";
import { discoverSkillMounts } from "../src/skills";

describe("discoverSkillMounts", () => {
	it("returns an array of MountSpec", () => {
		const mounts = discoverSkillMounts();
		expect(Array.isArray(mounts)).toBe(true);
	});

	it("all mounts have source, target, and mode='ro'", () => {
		const mounts = discoverSkillMounts();
		for (const m of mounts) {
			expect(typeof m.source).toBe("string");
			expect(typeof m.target).toBe("string");
			expect(m.target.startsWith("/skills/")).toBe(true);
			expect(m.mode).toBe("ro");
		}
	});
});
