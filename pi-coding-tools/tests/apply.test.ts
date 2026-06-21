import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatchDetailed } from "../src/apply";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-coding-tools-apply-"));
}

describe("applyPatchDetailed", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTempDir();
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("creates a new file (add hunk)", async () => {
		const patch = `*** Begin Patch
*** Add File: new.txt
+Hello
+World
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(result.appliedFiles).toEqual(["new.txt"]);
		const content = await import("node:fs/promises").then((m) => m.readFile(join(cwd, "new.txt"), "utf-8"));
		expect(content).toBe("Hello\nWorld\n");
	});

	it("creates nested directories for add hunk", async () => {
		const patch = `*** Begin Patch
*** Add File: deep/nested/dir/file.txt
+content
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(result.appliedFiles).toEqual(["deep/nested/dir/file.txt"]);
	});

	it("deletes a file (delete hunk)", async () => {
		writeFileSync(join(cwd, "old.txt"), "old content");
		const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(result.appliedFiles).toEqual(["old.txt"]);
		expect(() => statSync(join(cwd, "old.txt"))).toThrow();
	});

	it("fails to delete nonexistent file", async () => {
		const patch = `*** Begin Patch
*** Delete File: nonexistent.txt
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].filePath).toBe("nonexistent.txt");
	});

	it("updates a file with exact match", async () => {
		writeFileSync(join(cwd, "foo.ts"), "context\noldLine\nline3\n");
		const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 context
-oldLine
+newLine
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(join(cwd, "foo.ts"), "utf-8");
		expect(content).toContain("newLine");
		expect(content).not.toContain("oldLine");
	});

	it("updates with fuzzy match (trimEnd)", async () => {
		writeFileSync(join(cwd, "foo.ts"), "oldLine   \n");
		const patch = `*** Begin Patch
*** Update File: foo.ts
-oldLine
+newLine
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(result.details.fuzz).toBeGreaterThan(0);
	});

	it("appends at end of file with *** End of File", async () => {
		writeFileSync(join(cwd, "foo.ts"), "existing\n");
		const patch = `*** Begin Patch
*** Update File: foo.ts
@@ 
 existing
+appended
*** End of File
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(join(cwd, "foo.ts"), "utf-8");
		expect(content).toBe("existing\nappended\n");
	});

	it("moves a file with *** Move to", async () => {
		writeFileSync(join(cwd, "old.ts"), "content\n");
		const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@ 
-content
+newcontent
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(() => statSync(join(cwd, "old.ts"))).toThrow();
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(join(cwd, "new.ts"), "utf-8");
		expect(content).toBe("newcontent\n");
	});

	it("partial success: first hunk succeeds, second fails", async () => {
		writeFileSync(join(cwd, "exists.txt"), "content\n");
		const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Delete File: nonexistent.txt
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.hasPartialSuccess).toBe(true);
		expect(result.appliedFiles).toContain("first.txt");
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].filePath).toBe("nonexistent.txt");
	});

	it("recovery instructions: mustReadFiles = failures, mustNotReadFiles = successes", async () => {
		writeFileSync(join(cwd, "exists.txt"), "content\n");
		const patch = `*** Begin Patch
*** Add File: success.txt
+ok
*** Delete File: missing.txt
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.recoveryInstructions.mustReadFiles).toContain("missing.txt");
		expect(result.recoveryInstructions.mustNotReadFiles).toContain("success.txt");
	});

	it("rejects path escaping workspace via ..", async () => {
		const patch = `*** Begin Patch
*** Add File: ../../escape.txt
+escaped
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].message).toMatch(/escapes workspace/);
	});

	it("rejects absolute path outside workspace", async () => {
		const outsidePath = join(tmpdir(), "outside-absolute-test.txt");
		const patch = `*** Begin Patch
*** Add File: ${outsidePath}
+escaped
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].message).toMatch(/escapes workspace/);
	});

	it("accumulates fuzz score across multiple chunks", async () => {
		writeFileSync(join(cwd, "foo.ts"), "line1   \nline2  \n");
		const patch = `*** Begin Patch
*** Update File: foo.ts
-line1
+new1
-line2
+new2
*** End Patch`;
		const result = await applyPatchDetailed(cwd, patch);
		expect(result.failures).toHaveLength(0);
		expect(result.details.fuzz).toBeGreaterThan(0);
	});
});
