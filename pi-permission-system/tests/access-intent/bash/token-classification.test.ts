import { describe, expect, test } from "vitest";

import {
	classifyTokenAsPathCandidate,
	classifyTokenAsRuleCandidate,
} from "../../../src/access-intent/bash/token-classification";

// ── Shared rejection behaviour ─────────────────────────────────────────────
//
// Both classifiers delegate to the private `rejectNonPathToken` predicate for
// the seven shared rejection cases tested below.  Testing via both exports
// pins that predicate through each caller.

describe("classifyTokenAsPathCandidate", () => {
	describe("shared rejection: rejectNonPathToken", () => {
		test("empty string → null", () => {
			expect(classifyTokenAsPathCandidate("")).toBeNull();
		});

		test("flag (leading dash) → null", () => {
			expect(classifyTokenAsPathCandidate("-r")).toBeNull();
			expect(classifyTokenAsPathCandidate("--recursive")).toBeNull();
		});

		test("env assignment (= before any /) → null", () => {
			expect(classifyTokenAsPathCandidate("FOO=/bar")).toBeNull();
			expect(classifyTokenAsPathCandidate("HOME=/home/user")).toBeNull();
		});

		test("env-like token where = comes after / is NOT rejected as assignment", () => {
			// /foo=bar: slashIndex (0) < eqIndex (4) → not an assignment → continues
			// Starts with /, so path candidate accepts it.
			expect(classifyTokenAsPathCandidate("/foo=bar")).toBe("/foo=bar");
		});

		test("URL → null", () => {
			expect(classifyTokenAsPathCandidate("https://example.com")).toBeNull();
			expect(classifyTokenAsPathCandidate("http://localhost:3000")).toBeNull();
			expect(classifyTokenAsPathCandidate("file:///tmp/foo")).toBeNull();
			expect(classifyTokenAsPathCandidate("git+ssh://github.com/a/b")).toBeNull();
		});

		test("@scope/package → null", () => {
			expect(classifyTokenAsPathCandidate("@foo/bar")).toBeNull();
			expect(classifyTokenAsPathCandidate("@scope/pkg")).toBeNull();
		});

		test("@/ prefix is NOT rejected (it looks like an absolute-rooted scoped path)", () => {
			// @/ passes the @ guard; then for path candidate it doesn't start with /
			// or ~/, and doesn't contain .., so it returns null anyway from the
			// acceptance gate — but the rejection is not due to the @ guard.
			// This test documents that @/ is not rejected by the shared rejection.
			// The path classifier then rejects it for not matching any acceptance shape.
			expect(classifyTokenAsPathCandidate("@/foo/bar")).toBeNull();
		});

		test("bare-slash token → null", () => {
			expect(classifyTokenAsPathCandidate("/")).toBeNull();
			expect(classifyTokenAsPathCandidate("//")).toBeNull();
			expect(classifyTokenAsPathCandidate("///")).toBeNull();
		});

		test("regex metacharacters → null", () => {
			// REGEX_METACHAR_PATTERN: .*, .+, \|, \(, \), [...], ^/
			expect(classifyTokenAsPathCandidate("foo.*")).toBeNull();
			expect(classifyTokenAsPathCandidate("bar.+")).toBeNull();
			expect(classifyTokenAsPathCandidate("a\\|b")).toBeNull();
			expect(classifyTokenAsPathCandidate("\\(group\\)")).toBeNull();
			expect(classifyTokenAsPathCandidate("[abc]")).toBeNull();
			expect(classifyTokenAsPathCandidate("^/start")).toBeNull();
		});
	});

	describe("path-candidate acceptance gate", () => {
		test("absolute path (starts with /) → returned as-is", () => {
			expect(classifyTokenAsPathCandidate("/etc/hosts")).toBe("/etc/hosts");
			expect(classifyTokenAsPathCandidate("/tmp")).toBe("/tmp");
			expect(classifyTokenAsPathCandidate("/home/user/file.txt")).toBe("/home/user/file.txt");
		});

		test("home-relative path (starts with ~/) → returned as-is", () => {
			expect(classifyTokenAsPathCandidate("~/Documents")).toBe("~/Documents");
			expect(classifyTokenAsPathCandidate("~/.ssh/config")).toBe("~/.ssh/config");
		});

		test("parent-traversal (contains ..) → returned as-is", () => {
			expect(classifyTokenAsPathCandidate("../../etc/passwd")).toBe("../../etc/passwd");
			expect(classifyTokenAsPathCandidate("../foo")).toBe("../foo");
			expect(classifyTokenAsPathCandidate("..")).toBe("..");
		});

		test("plain word with no path shape → null", () => {
			expect(classifyTokenAsPathCandidate("hello")).toBeNull();
			expect(classifyTokenAsPathCandidate("myfile.txt")).toBeNull();
		});

		test("dot-file (starts with .) → null (strict path gate)", () => {
			// Path candidate does NOT accept dot-files; rule candidate does.
			expect(classifyTokenAsPathCandidate(".env")).toBeNull();
			expect(classifyTokenAsPathCandidate(".gitignore")).toBeNull();
		});

		test("relative path with / but no leading / or ~/ → null (strict path gate)", () => {
			// Path candidate does NOT accept bare relative paths; rule candidate does.
			expect(classifyTokenAsPathCandidate("src/foo.ts")).toBeNull();
			expect(classifyTokenAsPathCandidate("./build")).toBeNull();
		});
	});
});

describe("classifyTokenAsRuleCandidate", () => {
	describe("shared rejection: rejectNonPathToken", () => {
		test("empty string → null", () => {
			expect(classifyTokenAsRuleCandidate("")).toBeNull();
		});

		test("flag (leading dash) → null", () => {
			expect(classifyTokenAsRuleCandidate("-r")).toBeNull();
			expect(classifyTokenAsRuleCandidate("--recursive")).toBeNull();
		});

		test("env assignment (= before any /) → null", () => {
			expect(classifyTokenAsRuleCandidate("FOO=/bar")).toBeNull();
			expect(classifyTokenAsRuleCandidate("HOME=/home/user")).toBeNull();
		});

		test("env-like token where = comes after / is NOT rejected as assignment", () => {
			// /foo=bar: slashIndex (0) < eqIndex (4) → not an assignment → continues.
			// Contains /, so rule candidate accepts it.
			expect(classifyTokenAsRuleCandidate("/foo=bar")).toBe("/foo=bar");
		});

		test("URL → null", () => {
			expect(classifyTokenAsRuleCandidate("https://example.com")).toBeNull();
			expect(classifyTokenAsRuleCandidate("http://localhost:3000")).toBeNull();
			expect(classifyTokenAsRuleCandidate("file:///tmp/foo")).toBeNull();
		});

		test("@scope/package → null", () => {
			expect(classifyTokenAsRuleCandidate("@foo/bar")).toBeNull();
			expect(classifyTokenAsRuleCandidate("@scope/pkg")).toBeNull();
		});

		test("bare-slash token → null", () => {
			expect(classifyTokenAsRuleCandidate("/")).toBeNull();
			expect(classifyTokenAsRuleCandidate("//")).toBeNull();
		});

		test("regex metacharacters → null", () => {
			expect(classifyTokenAsRuleCandidate("foo.*")).toBeNull();
			expect(classifyTokenAsRuleCandidate("bar.+")).toBeNull();
			expect(classifyTokenAsRuleCandidate("a\\|b")).toBeNull();
			expect(classifyTokenAsRuleCandidate("[abc]")).toBeNull();
			expect(classifyTokenAsRuleCandidate("^/start")).toBeNull();
		});
	});

	describe("rule-candidate acceptance gate (broader than path)", () => {
		test("absolute path (starts with /) → returned as-is", () => {
			expect(classifyTokenAsRuleCandidate("/etc/hosts")).toBe("/etc/hosts");
		});

		test("home-relative path (starts with ~/) → returned as-is", () => {
			expect(classifyTokenAsRuleCandidate("~/Documents")).toBe("~/Documents");
		});

		test("parent-traversal (contains ..) → returned as-is", () => {
			expect(classifyTokenAsRuleCandidate("../foo")).toBe("../foo");
			expect(classifyTokenAsRuleCandidate("..")).toBe("..");
		});

		test("dot-file (starts with .) → returned as-is", () => {
			// Rule candidate accepts dot-files; path candidate does not.
			expect(classifyTokenAsRuleCandidate(".env")).toBe(".env");
			expect(classifyTokenAsRuleCandidate(".gitignore")).toBe(".gitignore");
		});

		test("current-dir relative (starts with ./) → returned as-is", () => {
			expect(classifyTokenAsRuleCandidate("./src")).toBe("./src");
			expect(classifyTokenAsRuleCandidate("./build/output.js")).toBe("./build/output.js");
		});

		test("relative path containing / → returned as-is", () => {
			// Rule candidate accepts any token with / (not already rejected).
			expect(classifyTokenAsRuleCandidate("src/foo.ts")).toBe("src/foo.ts");
			expect(classifyTokenAsRuleCandidate("packages/pi-foo/index.ts")).toBe("packages/pi-foo/index.ts");
		});

		test("plain word with no path shape → null", () => {
			expect(classifyTokenAsRuleCandidate("hello")).toBeNull();
			expect(classifyTokenAsRuleCandidate("myfile.txt")).toBeNull();
		});
	});

	describe("rule-vs-path divergence", () => {
		const dotFiles = [".env", ".gitignore", ".eslintrc"];
		const relPaths = ["src/index.ts", "lib/utils.js", "config/settings.json"];

		for (const tok of dotFiles) {
			test(`dot-file "${tok}": rule accepts, path rejects`, () => {
				expect(classifyTokenAsRuleCandidate(tok)).toBe(tok);
				expect(classifyTokenAsPathCandidate(tok)).toBeNull();
			});
		}

		for (const tok of relPaths) {
			test(`relative path "${tok}": rule accepts, path rejects`, () => {
				expect(classifyTokenAsRuleCandidate(tok)).toBe(tok);
				expect(classifyTokenAsPathCandidate(tok)).toBeNull();
			});
		}

		const sharedAccepted = ["/etc/hosts", "~/docs", "../sibling"];
		for (const tok of sharedAccepted) {
			test(`"${tok}": both classifiers accept`, () => {
				expect(classifyTokenAsRuleCandidate(tok)).toBe(tok);
				expect(classifyTokenAsPathCandidate(tok)).toBe(tok);
			});
		}

		const sharedRejected = ["hello", "--flag", "FOO=/bar", "https://x.com"];
		for (const tok of sharedRejected) {
			test(`"${tok}": both classifiers reject`, () => {
				expect(classifyTokenAsRuleCandidate(tok)).toBeNull();
				expect(classifyTokenAsPathCandidate(tok)).toBeNull();
			});
		}
	});
});
