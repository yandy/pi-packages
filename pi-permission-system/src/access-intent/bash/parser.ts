import { createRequire } from "node:module";
import { memoizeAsyncWithRetry } from "../../async-cache";

/**
 * Minimal subset of web-tree-sitter's SyntaxNode used by the AST walker.
 * Defined locally so callers do not need to import web-tree-sitter types.
 */
export interface TSNode {
  readonly type: string;
  readonly text: string;
  /** Absolute byte offset of this node's start in the parsed source. */
  readonly startIndex: number;
  readonly childCount: number;
  /** False for anonymous tokens (operators, delimiters); true for named nodes. */
  readonly isNamed: boolean;
  child(index: number): TSNode | null;
}

/**
 * Minimal subset of web-tree-sitter's Parser used by this module.
 */
interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

async function initParser(): Promise<TSParser> {
  // Use named imports — web-tree-sitter exports Parser as a named class.
  const { Parser, Language } = await import("web-tree-sitter");
  const req = createRequire(import.meta.url);
  const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => treeSitterWasm });

  const parser = new Parser();
  const bashWasm = req.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bash = await Language.load(bashWasm);
  parser.setLanguage(bash);
  return parser;
}

// Memoize on success but drop a rejected result so a transient init failure
// (e.g. a slow WASM load) is retried on the next tool call instead of poisoning
// the parser for the process lifetime.
export const getParser = memoizeAsyncWithRetry(initParser);
