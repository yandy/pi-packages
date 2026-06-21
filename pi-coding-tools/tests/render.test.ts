import { describe, expect, it } from "vitest";
import {
  countLines,
  createPatchDiff,
  displayPath,
  extractPatchedPaths,
  formatInFlightCallText,
  formatPatchPreview,
  truncatePreview,
  type ApplyPatchPreview,
} from "../src/render";

describe("truncatePreview", () => {
  it("returns short text unchanged", () => {
    expect(truncatePreview("hello")).toBe("hello");
  });

  it("truncates long text to char limit", () => {
    const long = "x".repeat(5000);
    const result = truncatePreview(long);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("truncates many-line text to line limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = truncatePreview(lines);
    expect(result.split("\n").length).toBeLessThanOrEqual(16);
  });
});

describe("countLines", () => {
  it("counts 0 for empty string", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts 1 for single line", () => {
    expect(countLines("hello")).toBe(1);
  });

  it("counts multiple lines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("extractPatchedPaths", () => {
  it("extracts paths from patch text", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+x
*** Update File: b.ts
*** Move to: c.ts
@@ ctx
-old
+new
*** End Patch`;
    expect(extractPatchedPaths(patch)).toEqual(["a.txt", "b.ts", "c.ts"]);
  });

  it("returns empty for no patch markers", () => {
    expect(extractPatchedPaths("nothing")).toEqual([]);
  });
});

describe("displayPath", () => {
  it("returns relative path as-is (normalized to /)", () => {
    expect(displayPath("foo/bar.ts", "/home/user/project")).toBe("foo/bar.ts");
  });

  it("returns relative path for absolute path inside cwd", () => {
    expect(displayPath("/home/user/project/src/file.ts", "/home/user/project")).toBe("src/file.ts");
  });

  it("returns absolute path for path outside cwd", () => {
    expect(displayPath("/etc/passwd", "/home/user/project")).toBe("/etc/passwd");
  });
});

describe("createPatchDiff", () => {
  it("generates diff with added/removed counts", () => {
    const result = createPatchDiff("old line\nsame", "new line\nsame");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.diff).toContain("+");
    expect(result.diff).toContain("-");
  });

  it("returns zero counts for identical content", () => {
    const result = createPatchDiff("same\ncontent", "same\ncontent");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});

describe("formatInFlightCallText", () => {
  it("returns 'Patching' when no paths found", () => {
    expect(formatInFlightCallText("no patch here")).toBe("Patching");
  });

  it("returns 'Patching: path' for single file", () => {
    const patch = "*** Begin Patch\n*** Add File: foo.txt\n+x\n*** End Patch";
    expect(formatInFlightCallText(patch)).toBe("Patching: foo.txt");
  });

  it("returns 'Patching (N files): ...' for multiple files", () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+x
*** Add File: b.txt
+y
*** End Patch`;
    expect(formatInFlightCallText(patch)).toBe("Patching (2 files): a.txt, b.txt");
  });
});

describe("formatPatchPreview", () => {
  it("formats single file preview", () => {
    const preview: ApplyPatchPreview = {
      files: [
        { filePath: "foo.ts", operation: "add", diff: "+new", added: 1, removed: 0 },
      ],
      added: 1,
      removed: 0,
    };
    const result = formatPatchPreview(preview, "/cwd", false);
    expect(result).toContain("foo.ts");
    expect(result).toContain("+1");
  });

  it("formats multi-file preview", () => {
    const preview: ApplyPatchPreview = {
      files: [
        { filePath: "a.ts", operation: "add", diff: "", added: 1, removed: 0 },
        { filePath: "b.ts", operation: "update", diff: "", added: 2, removed: 1 },
      ],
      added: 3,
      removed: 1,
    };
    const result = formatPatchPreview(preview, "/cwd", false);
    expect(result).toContain("2 files");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });
});
