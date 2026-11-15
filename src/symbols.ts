import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { Language, type Node, Parser, Query, type Tree } from "@vscode/tree-sitter-wasm";
import { embedded } from "./embedded";
import csharp from "./queries/c-sharp.scm" with { type: "text" };
import cpp from "./queries/cpp.scm" with { type: "text" };
import go from "./queries/go.scm" with { type: "text" };
import java from "./queries/java.scm" with { type: "text" };
import javascript from "./queries/javascript.scm" with { type: "text" };
import javascriptExtra from "./queries/javascript-extra.scm" with { type: "text" };
import outlineJs from "./queries/outline-js.scm" with { type: "text" };
import outlineJsOnly from "./queries/outline-js-only.scm" with { type: "text" };
import outlineTs from "./queries/outline-ts.scm" with { type: "text" };
import php from "./queries/php.scm" with { type: "text" };
import python from "./queries/python.scm" with { type: "text" };
import ruby from "./queries/ruby.scm" with { type: "text" };
import rust from "./queries/rust.scm" with { type: "text" };
import typescript from "./queries/typescript.scm" with { type: "text" };
import typescriptExtra from "./queries/typescript-extra.scm" with { type: "text" };
import type { Symbol as Sym } from "./types";

// Grammars come from VS Code's prebuilt package (built against the same runtime). Tag queries are
// the grammars' own queries/tags.scm, vendored in src/queries. TypeScript reuses JavaScript's.
// The *-extra files are nit's additions (type aliases, enums, top-level constants).
const JS = javascript + javascriptExtra;
const TS = JS + typescript + typescriptExtra;
// Outline queries (what the outline panel shows) are nit's own for JavaScript and TypeScript;
// other languages fall back to their tags.
const GRAMMARS: Record<string, { wasm: string; query: string; outline?: string }> = {
  typescript: { wasm: "tree-sitter-typescript.wasm", query: TS, outline: outlineJs + outlineTs },
  tsx: { wasm: "tree-sitter-tsx.wasm", query: TS, outline: outlineJs + outlineTs },
  javascript: { wasm: "tree-sitter-javascript.wasm", query: JS, outline: outlineJs + outlineJsOnly },
  python: { wasm: "tree-sitter-python.wasm", query: python },
  go: { wasm: "tree-sitter-go.wasm", query: go },
  rust: { wasm: "tree-sitter-rust.wasm", query: rust },
  java: { wasm: "tree-sitter-java.wasm", query: java },
  csharp: { wasm: "tree-sitter-c-sharp.wasm", query: csharp },
  ruby: { wasm: "tree-sitter-ruby.wasm", query: ruby },
  php: { wasm: "tree-sitter-php.wasm", query: php },
  cpp: { wasm: "tree-sitter-cpp.wasm", query: cpp },
};
export type Grammar =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "ruby"
  | "php"
  | "cpp";

const BY_EXT: Record<string, Grammar> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".h": "cpp",
};

export const grammarFor = (path: string): Grammar | null => BY_EXT[extname(path).toLowerCase()] ?? null;

/** A grammar's .wasm: baked into the binary, or from the package on disk. */
let wasmDir: string | undefined;
function wasm(file: string) {
  const inside = embedded.wasm.get(file);
  if (inside) return inside;
  wasmDir ??= join(dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
  return join(wasmDir, file);
}
/** Every .wasm nit loads, for scripts/compile.ts to bake in. */
export const WASM_FILES = ["tree-sitter.wasm", ...new Set(Object.values(GRAMMARS).map((g) => g.wasm))];

let ready: Promise<void> | null = null;
function init() {
  if (!ready) ready = Parser.init({ locateFile: (f: string) => wasm(f) });
  return ready;
}

type Loaded = { parser: Parser; query: Query; outline: Query | null };
const loaded = new Map<Grammar, Promise<Loaded>>();

export function load(grammar: Grammar): Promise<Loaded> {
  let p = loaded.get(grammar);
  if (!p) {
    p = (async () => {
      await init();
      const language = await Language.load(wasm(GRAMMARS[grammar].wasm));
      const parser = new Parser();
      parser.setLanguage(language);
      const g = GRAMMARS[grammar];
      let query: Query | undefined;
      return {
        parser,
        get query() {
          return (query ??= new Query(language, g.query));
        },
        outline: g.outline ? new Query(language, g.outline) : null,
      };
    })();
    loaded.set(grammar, p);
  }
  return p;
}

// Parsed files, keyed by caller (path + version). Trees hold WASM memory, so old ones are freed.
/** `symbols` are definitions (for navigation); `outline` is what a reader scans the file by. */
type Parsed = { tree: Tree; grammar: Grammar; symbols: Sym[]; outline: Sym[]; release(): void };
const parsed = new Map<string, Parsed>();
const MAX_PARSED = 200;

export async function parse(key: string, path: string, source: string): Promise<Parsed | null> {
  const hit = parsed.get(key);
  if (hit) {
    parsed.delete(key);
    parsed.set(key, hit); // most recently used last
    return hit;
  }
  const grammar = grammarFor(path);
  if (!grammar) return null;
  const loaded = await load(grammar);
  const tree = loaded.parser.parse(source);
  if (!tree) return null;
  // The outline has its own query for JS/TS; navigation pays for definitions only when used.
  let symbols: Sym[] | undefined;
  let retainedSource: string | null = source;
  let live = true;
  const getSymbols = () => {
    if (symbols) return symbols;
    const target = live ? tree : loaded.parser.parse(retainedSource!);
    if (!target) return [];
    try {
      symbols = definitions(target, loaded.query);
      retainedSource = null;
      return symbols;
    } finally {
      if (!live) target.delete();
    }
  };
  const entry: Parsed = {
    tree,
    grammar,
    release() {
      live = false;
      tree.delete();
    },
    get symbols() {
      return getSymbols();
    },
    outline: loaded.outline ? outline(tree, loaded.outline) : getSymbols(),
  };
  parsed.set(key, entry);
  if (parsed.size > MAX_PARSED) {
    const [oldest, value] = parsed.entries().next().value!;
    parsed.delete(oldest);
    // A caller retaining the entry can still derive definitions from its source if needed.
    value.release();
  }
  return entry;
}

/** Definitions from the tags query (@definition.* with its @name), ordered by position. */
function definitions(tree: Tree, query: Query): Sym[] {
  const seen = new Map<number, number>(); // definition node → index in out
  const out: Sym[] = [];
  for (const m of query.matches(tree.rootNode)) {
    const def = m.captures.find((c) => c.name.startsWith("definition."));
    const name = m.captures.find((c) => c.name === "name");
    if (!def || !name) continue;
    const kind = def.name.slice("definition.".length);
    const at = seen.get(def.node.id);
    if (at !== undefined) {
      // A const holding a function is matched as both; "function" says more than "constant".
      if (out[at].kind === "constant" && kind !== "constant") out[at].kind = kind;
      continue;
    }
    seen.set(def.node.id, out.length);
    out.push({
      name: name.node.text,
      kind,
      line: def.node.startPosition.row + 1,
      startCol: def.node.startPosition.column,
      endLine: def.node.endPosition.row + 1,
      endCol: def.node.endPosition.column,
      nameLine: name.node.startPosition.row + 1,
      nameCol: name.node.startPosition.column,
    });
  }
  return out.sort((a, b) => a.line - b.line || (a.startCol ?? 0) - (b.startCol ?? 0) || b.endLine - a.endLine);
}

const IDENT = /identifier|^name$|^constant$|^field$|^property$/;
const isIdentifier = (n: Node) => n.childCount === 0 && IDENT.test(n.type);

const SUITE = /^(describe|context|suite)$/;
const unquote = (s: string) => s.replace(/^[`'"]|[`'"]$/g, "");

/** The outline query's items (@item.* with @name), nested by position. Test blocks are named by their string. */
function outline(tree: Tree, query: Query): Sym[] {
  const seen = new Map<number, number>();
  const out: Sym[] = [];
  for (const m of query.matches(tree.rootNode)) {
    const item = m.captures.find((c) => c.name.startsWith("item."));
    const name = m.captures.find((c) => c.name === "name");
    if (!item || !name) continue;
    let kind = item.name.slice("item.".length);
    if (kind === "test") kind = SUITE.test(m.captures.find((c) => c.name === "fn")?.node.text ?? "") ? "suite" : "test";
    const at = seen.get(item.node.id);
    if (at !== undefined) {
      // A const holding a function matches as both; "function" says more than "variable".
      if (out[at].kind === "variable" && kind !== "variable") out[at].kind = kind;
      continue;
    }
    seen.set(item.node.id, out.length);
    out.push({
      name: kind === "test" || kind === "suite" ? unquote(name.node.text) : name.node.text,
      kind,
      line: item.node.startPosition.row + 1,
      startCol: item.node.startPosition.column,
      endLine: item.node.endPosition.row + 1,
      endCol: item.node.endPosition.column,
      nameLine: name.node.startPosition.row + 1,
      nameCol: name.node.startPosition.column,
    });
  }
  return out.sort((a, b) => a.line - b.line || (a.startCol ?? 0) - (b.startCol ?? 0) || b.endLine - a.endLine);
}

/** The identifier at a 1-based line and 0-based column, or null on punctuation, strings, comments. */
export function identifierAt(p: Parsed, line: number, col: number): string | null {
  const n = p.tree.rootNode.descendantForPosition({ row: line - 1, column: col });
  return n && isIdentifier(n) ? n.text : null;
}

/** Distinct identifiers on a line, left to right. Keywords and literals aren't identifiers. */
export function identifiersOnLine(p: Parsed, line: number): { name: string; col: number }[] {
  const out: { name: string; col: number }[] = [];
  const seen = new Set<string>();
  const row = line - 1;
  const walk = (n: Node) => {
    if (n.endPosition.row < row || n.startPosition.row > row) return;
    if (isIdentifier(n)) {
      if (n.startPosition.row === row && !seen.has(n.text)) {
        seen.add(n.text);
        out.push({ name: n.text, col: n.startPosition.column });
      }
      return;
    }
    for (const c of n.children) if (c) walk(c);
  };
  walk(p.tree.rootNode);
  return out;
}
