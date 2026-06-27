import { describe, expect, it } from "vitest";
import { getParser } from "../../../src/access-intent/bash/parser";

describe("getParser", () => {
  it("parses a simple bash command and returns a non-null root node", async () => {
    const parser = await getParser();
    const tree = parser.parse("echo hi");
    expect(tree).not.toBeNull();
    expect(tree?.rootNode).toBeDefined();
    expect(tree?.rootNode.type).toBe("program");
    tree?.delete();
  });

  it("returns the same memoized parser instance on repeated calls", async () => {
    const first = await getParser();
    const second = await getParser();
    expect(first).toBe(second);
  });
});
