import { describe, expect, it } from "vitest";
import type { TSNode } from "../../../src/access-intent/bash/parser";
import { getParser } from "../../../src/access-intent/bash/parser";
import {
  collectCommandTokens,
  collectPathCandidateTokens,
  collectRedirectTokens,
  extractCommandName,
} from "../../../src/access-intent/bash/token-collection";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Depth-first search for the first node of the given type. */
function findNode(node: TSNode, type: string): TSNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const found = findNode(child, type);
    if (found) return found;
  }
  return null;
}

/** Parse a bash snippet and return the first `command` node. */
async function parseCommandNode(cmd: string): Promise<{
  node: TSNode;
  tree: { rootNode: TSNode; delete(): void };
}> {
  const parser = await getParser();
  const tree = parser.parse(cmd);
  if (!tree) throw new Error("parser.parse returned null");
  const node = findNode(tree.rootNode, "command");
  if (!node) throw new Error(`no command node found in: ${cmd}`);
  return { node, tree };
}

/** Parse a bash snippet and return the first `file_redirect` node. */
async function parseRedirectNode(cmd: string): Promise<{
  node: TSNode;
  tree: { rootNode: TSNode; delete(): void };
}> {
  const parser = await getParser();
  const tree = parser.parse(cmd);
  if (!tree) throw new Error("parser.parse returned null");
  const node = findNode(tree.rootNode, "file_redirect");
  if (!node) throw new Error(`no file_redirect node found in: ${cmd}`);
  return { node, tree };
}

// ── extractCommandName ────────────────────────────────────────────────────────

describe("extractCommandName", () => {
  it("returns the basename for a bare command", async () => {
    const { node, tree } = await parseCommandNode("sed 's/x/y/' file.txt");
    try {
      expect(extractCommandName(node)).toBe("sed");
    } finally {
      tree.delete();
    }
  });

  it("strips the directory prefix from an absolute command path", async () => {
    const { node, tree } = await parseCommandNode(
      "/usr/bin/sed 's/x/y/' file.txt",
    );
    try {
      expect(extractCommandName(node)).toBe("sed");
    } finally {
      tree.delete();
    }
  });

  it("returns the substitution text when the command name is a command substitution", async () => {
    // $(which sed) parses with a command_name child whose text is "$(which sed)";
    // resolveNodeText returns that text, so extractCommandName returns its basename.
    // PATTERN_FIRST_COMMANDS.get("$(which sed)") returns undefined, so
    // collectCommandTokens falls back to generic collection — correct behaviour.
    const { node, tree } = await parseCommandNode(
      "$(which sed) 's/x/y/' file.txt",
    );
    try {
      expect(extractCommandName(node)).toBe("$(which sed)");
    } finally {
      tree.delete();
    }
  });
});

// ── collectCommandTokens — pattern-first commands ─────────────────────────────

describe("collectCommandTokens — pattern-first commands", () => {
  it("sed: skips the first positional (inline pattern) and collects the rest", async () => {
    const { node, tree } = await parseCommandNode("sed 's/x/y/' a.txt b.txt");
    try {
      expect(collectCommandTokens(node)).toEqual(["a.txt", "b.txt"]);
    } finally {
      tree.delete();
    }
  });

  it("sed -e: skips the explicit script arg-consuming flag and collects positionals", async () => {
    const { node, tree } = await parseCommandNode("sed -e 's/x/y/' file.txt");
    try {
      // -e consumes the next argument (the script), so file.txt is the first positional
      // Since hasExplicitScript is set by -e, the positional is not skipped
      expect(collectCommandTokens(node)).toEqual(["file.txt"]);
    } finally {
      tree.delete();
    }
  });

  it("sed -f: treats the next argument as a file path (file-consuming flag)", async () => {
    const { node, tree } = await parseCommandNode(
      "sed -f /scripts/script.sed file.txt",
    );
    try {
      // -f consumes the next arg as a file path (extracted), and sets hasExplicitScript
      expect(collectCommandTokens(node)).toEqual([
        "/scripts/script.sed",
        "file.txt",
      ]);
    } finally {
      tree.delete();
    }
  });

  it("grep: skips the first positional (pattern) and collects file arguments", async () => {
    const { node, tree } = await parseCommandNode(
      "grep pattern /etc/hosts /etc/passwd",
    );
    try {
      expect(collectCommandTokens(node)).toEqual(["/etc/hosts", "/etc/passwd"]);
    } finally {
      tree.delete();
    }
  });

  it("grep -e: with explicit -e flag, all positionals are file arguments", async () => {
    const { node, tree } = await parseCommandNode("grep -e pattern /etc/hosts");
    try {
      expect(collectCommandTokens(node)).toEqual(["/etc/hosts"]);
    } finally {
      tree.delete();
    }
  });

  it("grep: end-of-flags (--) causes subsequent args to be treated as positionals", async () => {
    const { node, tree } = await parseCommandNode("grep -- pattern /etc/hosts");
    try {
      // After --, both 'pattern' (first positional) and '/etc/hosts' are positionals.
      // pattern is the pattern positional and is skipped; /etc/hosts is collected.
      expect(collectCommandTokens(node)).toEqual(["/etc/hosts"]);
    } finally {
      tree.delete();
    }
  });

  it("sd: skips the first two positionals (FIND and REPLACE_WITH) as patterns", async () => {
    const { node, tree } = await parseCommandNode(
      "sd find replace file.txt other.txt",
    );
    try {
      expect(collectCommandTokens(node)).toEqual(["file.txt", "other.txt"]);
    } finally {
      tree.delete();
    }
  });

  it("rg: skips the pattern positional and collects file/dir arguments", async () => {
    const { node, tree } = await parseCommandNode("rg pattern /etc/");
    try {
      expect(collectCommandTokens(node)).toEqual(["/etc/"]);
    } finally {
      tree.delete();
    }
  });
});

// ── collectCommandTokens — generic commands ───────────────────────────────────

describe("collectCommandTokens — generic commands", () => {
  it("collects all argument tokens after the command name", async () => {
    const { node, tree } = await parseCommandNode("cat /etc/hosts /etc/passwd");
    try {
      expect(collectCommandTokens(node)).toEqual(["/etc/hosts", "/etc/passwd"]);
    } finally {
      tree.delete();
    }
  });

  it("skips variable assignment prefixes", async () => {
    const { node, tree } = await parseCommandNode("FOO=/bar cat /etc/hosts");
    try {
      expect(collectCommandTokens(node)).toEqual(["/etc/hosts"]);
    } finally {
      tree.delete();
    }
  });

  it("collects no tokens for a bare command with no arguments", async () => {
    const { node, tree } = await parseCommandNode("ls");
    try {
      expect(collectCommandTokens(node)).toEqual([]);
    } finally {
      tree.delete();
    }
  });
});

// ── collectRedirectTokens ─────────────────────────────────────────────────────

describe("collectRedirectTokens", () => {
  it("collects the destination path from a stdout redirect", async () => {
    const { node, tree } = await parseRedirectNode(
      "cat /etc/hosts > /tmp/out.txt",
    );
    try {
      expect(collectRedirectTokens(node)).toEqual(["/tmp/out.txt"]);
    } finally {
      tree.delete();
    }
  });

  it("collects the destination path from an append redirect", async () => {
    const { node, tree } = await parseRedirectNode(
      "echo hello >> /tmp/log.txt",
    );
    try {
      expect(collectRedirectTokens(node)).toEqual(["/tmp/log.txt"]);
    } finally {
      tree.delete();
    }
  });

  it("collects the source path from a stdin redirect", async () => {
    const { node, tree } = await parseRedirectNode("cat < /etc/hosts");
    try {
      expect(collectRedirectTokens(node)).toEqual(["/etc/hosts"]);
    } finally {
      tree.delete();
    }
  });
});

// ── collectPathCandidateTokens ────────────────────────────────────────────────

describe("collectPathCandidateTokens", () => {
  it("collects all argument tokens from a simple command via the program root", async () => {
    const parser = await getParser();
    const tree = parser.parse("cat /etc/hosts");
    try {
      if (!tree) throw new Error("parse returned null");
      expect(collectPathCandidateTokens(tree.rootNode)).toEqual(["/etc/hosts"]);
    } finally {
      tree?.delete();
    }
  });

  it("collects redirect destinations as well as command arguments", async () => {
    const parser = await getParser();
    const tree = parser.parse("cat /etc/hosts > /tmp/out.txt");
    try {
      if (!tree) throw new Error("parse returned null");
      expect(collectPathCandidateTokens(tree.rootNode)).toEqual([
        "/etc/hosts",
        "/tmp/out.txt",
      ]);
    } finally {
      tree?.delete();
    }
  });

  it("returns empty array for heredoc-only content (SKIP_SUBTREE_TYPES)", async () => {
    const parser = await getParser();
    const tree = parser.parse("cat <<EOF\nhello\nEOF");
    try {
      if (!tree) throw new Error("parse returned null");
      // heredoc_body is in SKIP_SUBTREE_TYPES — its text must not be collected
      const tokens = collectPathCandidateTokens(tree.rootNode);
      expect(tokens).not.toContain("hello");
    } finally {
      tree?.delete();
    }
  });

  it("recurses into command substitution to collect nested tokens", async () => {
    const parser = await getParser();
    const tree = parser.parse("cat $(echo /etc/hosts)");
    try {
      if (!tree) throw new Error("parse returned null");
      // The command_substitution is a non-command, non-redirect node — recurse
      const tokens = collectPathCandidateTokens(tree.rootNode);
      // /etc/hosts is inside the substitution, collected by recursion
      expect(tokens).toContain("/etc/hosts");
    } finally {
      tree?.delete();
    }
  });
});
