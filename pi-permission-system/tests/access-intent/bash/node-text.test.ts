import { describe, expect, it } from "vitest";
import {
  resolveNodeText,
  SKIP_SUBTREE_TYPES,
} from "../../../src/access-intent/bash/node-text";
import type { TSNode } from "../../../src/access-intent/bash/parser";

// Minimal fake TSNode builder — only fills the fields resolveNodeText reads.
function makeNode(type: string, text: string, children: TSNode[] = []): TSNode {
  return {
    type,
    text,
    startIndex: 0,
    childCount: children.length,
    isNamed: true,
    child: (i) => children[i] ?? null,
  };
}

describe("SKIP_SUBTREE_TYPES", () => {
  it("contains the three node types that must not be descended", () => {
    expect(SKIP_SUBTREE_TYPES.has("heredoc_body")).toBe(true);
    expect(SKIP_SUBTREE_TYPES.has("heredoc_end")).toBe(true);
    expect(SKIP_SUBTREE_TYPES.has("comment")).toBe(true);
  });

  it("does not contain common argument node types", () => {
    expect(SKIP_SUBTREE_TYPES.has("word")).toBe(false);
    expect(SKIP_SUBTREE_TYPES.has("string")).toBe(false);
    expect(SKIP_SUBTREE_TYPES.has("raw_string")).toBe(false);
  });
});

describe("resolveNodeText", () => {
  describe("word nodes", () => {
    it("returns the node text unchanged", () => {
      expect(resolveNodeText(makeNode("word", "hello"))).toBe("hello");
    });
  });

  describe("raw_string nodes (single-quoted)", () => {
    it("strips surrounding single quotes", () => {
      expect(resolveNodeText(makeNode("raw_string", "'content'"))).toBe(
        "content",
      );
    });

    it("strips single quotes around a path", () => {
      expect(resolveNodeText(makeNode("raw_string", "'/etc/hosts'"))).toBe(
        "/etc/hosts",
      );
    });

    it("returns text as-is when not fully single-quoted", () => {
      // A raw_string node without enclosing quotes (defensive fallback)
      expect(resolveNodeText(makeNode("raw_string", "noquotes"))).toBe(
        "noquotes",
      );
    });
  });

  describe("string nodes (double-quoted)", () => {
    it("concatenates inner word children, skipping quote delimiters", () => {
      const quoteOpen = makeNode('"', '"');
      const content = makeNode("string_content", "hello world");
      const quoteClose = makeNode('"', '"');
      const node = makeNode("string", '"hello world"', [
        quoteOpen,
        content,
        quoteClose,
      ]);
      expect(resolveNodeText(node)).toBe("hello world");
    });

    it("concatenates multiple inner children", () => {
      const quoteOpen = makeNode('"', '"');
      const part1 = makeNode("string_content", "foo");
      const part2 = makeNode("simple_expansion", "$BAR");
      const quoteClose = makeNode('"', '"');
      const node = makeNode("string", '"foo$BAR"', [
        quoteOpen,
        part1,
        part2,
        quoteClose,
      ]);
      expect(resolveNodeText(node)).toBe("foo$BAR");
    });

    it("returns empty string for an empty double-quoted string", () => {
      const quoteOpen = makeNode('"', '"');
      const quoteClose = makeNode('"', '"');
      const node = makeNode("string", '""', [quoteOpen, quoteClose]);
      expect(resolveNodeText(node)).toBe("");
    });
  });

  describe("string_content, simple_expansion, and expansion nodes", () => {
    it("returns text as-is for string_content", () => {
      expect(resolveNodeText(makeNode("string_content", "plain text"))).toBe(
        "plain text",
      );
    });

    it("returns text as-is for simple_expansion (e.g. $HOME)", () => {
      // retro 0350: $HOME returns the literal text of a simple_expansion node
      expect(resolveNodeText(makeNode("simple_expansion", "$HOME"))).toBe(
        "$HOME",
      );
    });

    it("returns text as-is for expansion", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — testing that expansion node text is returned verbatim
      expect(resolveNodeText(makeNode("expansion", "${VAR}"))).toBe("${VAR}");
    });
  });

  describe("concatenation nodes", () => {
    it("concatenates resolved children", () => {
      const word = makeNode("word", "/etc/");
      const expansion = makeNode("simple_expansion", "$FILE");
      const node = makeNode("concatenation", "/etc/$FILE", [word, expansion]);
      expect(resolveNodeText(node)).toBe("/etc/$FILE");
    });

    it("handles nested concatenation-of-string", () => {
      // A concatenation whose child is a double-quoted string
      const quoteOpen = makeNode('"', '"');
      const content = makeNode("string_content", "bar");
      const quoteClose = makeNode('"', '"');
      const inner = makeNode("string", '"bar"', [
        quoteOpen,
        content,
        quoteClose,
      ]);
      const prefix = makeNode("word", "foo");
      const node = makeNode("concatenation", 'foo"bar"', [prefix, inner]);
      expect(resolveNodeText(node)).toBe("foobar");
    });
  });

  describe("default fallback", () => {
    it("returns the raw text for unknown node types", () => {
      expect(resolveNodeText(makeNode("unknown_type", "rawtext"))).toBe(
        "rawtext",
      );
    });
  });
});
