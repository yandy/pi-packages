import { describe, expect, it } from "vitest";

import { evaluate } from "../src/rule";
import { SessionApproval } from "../src/session-approval";
import type { SessionApprovalRecorder } from "../src/session-approval-recorder";
import { deriveApprovalPattern, SessionRules } from "../src/session-rules";

// ── SessionRules ───────────────────────────────────────────────────────────

describe("SessionRules", () => {
	describe("getRuleset", () => {
		it("returns an empty ruleset initially", () => {
			const rules = new SessionRules();
			expect(rules.getRuleset()).toEqual([]);
		});

		it("returns a ruleset containing approved rules", () => {
			const rules = new SessionRules();
			rules.approve("external_directory", "/other/project/*");
			expect(rules.getRuleset()).toEqual([
				{
					surface: "external_directory",
					pattern: "/other/project/*",
					action: "allow",
					layer: "session",
					origin: "session",
				},
			]);
		});

		it("returns a defensive copy — mutations do not affect internal state", () => {
			const rules = new SessionRules();
			rules.approve("external_directory", "/other/project/*");
			const copy = rules.getRuleset();
			copy.push({
				surface: "bash",
				pattern: "*",
				action: "deny",
				origin: "session",
			});
			expect(rules.getRuleset()).toHaveLength(1);
		});

		it("accumulates multiple approved patterns", () => {
			const rules = new SessionRules();
			rules.approve("external_directory", "/project-a/*");
			rules.approve("external_directory", "/project-b/*");
			expect(rules.getRuleset()).toHaveLength(2);
		});
	});

	describe("clear", () => {
		it("removes all session rules", () => {
			const rules = new SessionRules();
			rules.approve("external_directory", "/other/project/*");
			rules.approve("external_directory", "/another/path/*");
			rules.clear();
			expect(rules.getRuleset()).toEqual([]);
		});

		it("allows new approvals after clearing", () => {
			const rules = new SessionRules();
			rules.approve("external_directory", "/old/path/*");
			rules.clear();
			rules.approve("external_directory", "/new/path/*");
			expect(rules.getRuleset()).toHaveLength(1);
			expect(rules.getRuleset()[0].pattern).toBe("/new/path/*");
		});
	});

	describe("recordSessionApproval", () => {
		it("satisfies the SessionApprovalRecorder interface", () => {
			const rules: SessionApprovalRecorder = new SessionRules();
			expect(typeof rules.recordSessionApproval).toBe("function");
		});

		it("records a single-pattern approval as one rule", () => {
			const rules = new SessionRules();
			rules.recordSessionApproval(SessionApproval.single("bash", "git *"));
			expect(rules.getRuleset()).toEqual([
				{
					surface: "bash",
					pattern: "git *",
					action: "allow",
					layer: "session",
					origin: "session",
				},
			]);
		});

		it("records a multi-pattern approval as one rule per pattern", () => {
			const rules = new SessionRules();
			rules.recordSessionApproval(SessionApproval.multiple("external_directory", ["/outside/a/*", "/outside/b/*"]));
			expect(rules.getRuleset()).toHaveLength(2);
			expect(rules.getRuleset()[0].pattern).toBe("/outside/a/*");
			expect(rules.getRuleset()[1].pattern).toBe("/outside/b/*");
		});

		it("records each rule with the correct surface", () => {
			const rules = new SessionRules();
			rules.recordSessionApproval(SessionApproval.multiple("external_directory", ["/outside/a/*", "/outside/b/*"]));
			for (const rule of rules.getRuleset()) {
				expect(rule.surface).toBe("external_directory");
			}
		});

		it("records nothing for an empty patterns list", () => {
			const rules = new SessionRules();
			rules.recordSessionApproval(SessionApproval.multiple("external_directory", []));
			expect(rules.getRuleset()).toEqual([]);
		});
	});

	describe("evaluate() integration", () => {
		it("returns allow for a path under an approved directory", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/other/project/*");
			const result = evaluate("external_directory", "/other/project/src/foo.ts", session.getRuleset());
			expect(result.action).toBe("allow");
		});

		it("returns ask (default) for a path outside approved directories", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/other/project/*");
			const result = evaluate("external_directory", "/other/unrelated/file.ts", session.getRuleset());
			// No rule matches — evaluate returns synthetic rule with default action "ask"
			expect(result.action).toBe("ask");
		});

		it("does not match a sibling directory that shares a string prefix", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/other/project/*");
			const result = evaluate("external_directory", "/other/project-b/foo.ts", session.getRuleset());
			expect(result.action).toBe("ask");
		});

		it("matches the directory itself (trailing slash)", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/other/project/src/*");
			// The * in wildcardMatch maps to .* which matches zero chars — so /src/ is covered.
			const result = evaluate("external_directory", "/other/project/src/", session.getRuleset());
			expect(result.action).toBe("allow");
		});

		it("handles multiple approved directories", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/project-a/*");
			session.approve("external_directory", "/project-b/*");
			expect(evaluate("external_directory", "/project-a/foo.ts", session.getRuleset()).action).toBe("allow");
			expect(evaluate("external_directory", "/project-b/bar.ts", session.getRuleset()).action).toBe("allow");
			expect(evaluate("external_directory", "/project-c/baz.ts", session.getRuleset()).action).toBe("ask");
		});

		it("does not match a different surface", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/other/project/*");
			const result = evaluate("bash", "/other/project/foo.ts", session.getRuleset());
			expect(result.action).toBe("ask");
		});

		it("returns allow after clearing and re-approving", () => {
			const session = new SessionRules();
			session.approve("external_directory", "/old/project/*");
			session.clear();
			session.approve("external_directory", "/new/project/*");
			expect(evaluate("external_directory", "/old/project/file.ts", session.getRuleset()).action).toBe("ask");
			expect(evaluate("external_directory", "/new/project/file.ts", session.getRuleset()).action).toBe("allow");
		});
	});
});

// ── deriveApprovalPattern ──────────────────────────────────────────────────

describe("deriveApprovalPattern", () => {
	it("returns parent directory glob for a file path", () => {
		expect(deriveApprovalPattern("/other/project/src/foo.ts")).toBe("/other/project/src/*");
	});

	it("returns directory glob when path already ends with separator", () => {
		expect(deriveApprovalPattern("/other/project/src/")).toBe("/other/project/src/*");
	});

	it("returns parent directory glob for a directory-like path without trailing separator", () => {
		// Cannot distinguish dir from file — dirname is the safe choice
		expect(deriveApprovalPattern("/other/project/src")).toBe("/other/project/*");
	});

	it("handles root path", () => {
		expect(deriveApprovalPattern("/")).toBe("/*");
	});

	it("handles single-level path", () => {
		expect(deriveApprovalPattern("/foo")).toBe("/*");
	});

	it("produces a pattern that matches paths under the approved directory", () => {
		const pattern = deriveApprovalPattern("/other/project/src/foo.ts");
		const session = new SessionRules();
		session.approve("external_directory", pattern);
		expect(evaluate("external_directory", "/other/project/src/bar.ts", session.getRuleset()).action).toBe("allow");
	});

	it("produces a pattern that does not match sibling directories", () => {
		const pattern = deriveApprovalPattern("/other/project/src/foo.ts");
		const session = new SessionRules();
		session.approve("external_directory", pattern);
		expect(evaluate("external_directory", "/other/project/lib/bar.ts", session.getRuleset()).action).toBe("ask");
	});

	it("binds a current-directory file to the cwd subtree once resolved", () => {
		// Callers resolve the path to its canonical absolute form before deriving;
		// a current-directory file then yields the cwd glob and excludes siblings.
		const pattern = deriveApprovalPattern("/test/project/index.html");
		expect(pattern).toBe("/test/project/*");
		const session = new SessionRules();
		session.approve("edit", pattern);
		expect(evaluate("edit", "/test/project/index.html", session.getRuleset()).action).toBe("allow");
		expect(evaluate("edit", "/etc/passwd", session.getRuleset()).action).toBe("ask");
	});
});
