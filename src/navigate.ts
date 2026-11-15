import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { FileFinder, type GrepCursor, type GrepMatch } from "@ff-labs/fff-bun";
import { parsePatchFiles } from "@pierre/diffs";
import * as git from "./git";
import { type ModuleShape, moduleShape, namespaceOf } from "./imports";
import { identifierAt, identifiersOnLine, parse } from "./symbols";
import type { Location, SearchResult, Side, Symbol as Sym } from "./types";
import { changedLines } from "./ui/lines";

const SNIPPET_LINES = 15;
const MAX_FILES_CHECKED = 150;

const JS_LIKE = /\.(m|c)?[jt]sx?$/;
const COMPILED_JS = /\.(m|c)?jsx?$/;

/** For a compiled dependency file, its type declarations: a sibling .d.ts, or the package's "types". */
function typesFor(js: string): string | null {
  for (const c of [js.replace(COMPILED_JS, ".d.ts"), js.replace(/\.mjs$/, ".d.mts"), js.replace(/\.cjs$/, ".d.cts")])
    if (c !== js && existsSync(c)) return c;
  for (let dir = dirname(js); dir !== dirname(dir); dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const { types, typings } = JSON.parse(readFileSync(pkg, "utf8")) as { types?: string; typings?: string };
      const t = types ?? typings;
      return t && existsSync(join(dir, t)) ? join(dir, t) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** fff reports byte columns; JavaScript strings count UTF-16 units. */
const charCol = (line: string, byteCol: number) => Buffer.from(line).subarray(0, byteCol).toString().length;

/**
 * Code navigation for one review: fff finds candidate lines across the repo from its warm index,
 * tree-sitter confirms which are real definitions and which are identifiers rather than text in
 * comments or strings.
 */
export async function createNavigator(root: string, mergeBase: string, patch: () => Promise<string>) {
  const created = FileFinder.create({ basePath: root });
  if (!created.ok) throw new Error(`nit: file index failed: ${created.error}`);
  const finder = created.value;
  const realRoot = realpathSync(root);
  const scanned = finder.waitForScan(10_000);

  // Which files are in the diff and which of their lines changed, refreshed when the patch changes.
  let diffKey = "";
  let diff = new Map<string, Set<number>>();
  async function diffInfo() {
    const text = await patch();
    if (text !== diffKey) {
      diffKey = text;
      diff = new Map(parsePatchFiles(text).flatMap((p) => p.files.map((f) => [f.name, changedLines(f).added])));
    }
    return diff;
  }

  async function source(path: string, side: Side) {
    if (side === "deletions")
      return { key: `base:${mergeBase}:${path}`, text: await git.readAtRef(root, mergeBase, path) };
    const file = Bun.file(git.safePath(root, path));
    if (!(await file.exists())) return { key: "", text: null };
    return { key: `work:${path}:${file.lastModified}:${file.size}`, text: await file.text() };
  }

  async function parsed(path: string, side: Side) {
    const s = await source(path, side);
    return s.text === null ? null : { parsed: await parse(s.key, path, s.text), text: s.text };
  }

  function location(path: string, line: number, col: number, text: string, diffs: Map<string, Set<number>>): Location {
    return {
      path,
      line,
      col,
      text: text.trim(),
      inDiff: diffs.has(path),
      changed: diffs.get(path)?.has(line) ?? false,
    };
  }

  // ---------- following imports (JavaScript and TypeScript)

  type Found = { path: string; sym: Sym; text: string };
  type Parsed = NonNullable<Awaited<ReturnType<typeof parse>>>;
  const shapes = new WeakMap<Parsed, ModuleShape>();
  const shapeOf = (p: Parsed) => {
    let shape = shapes.get(p);
    if (!shape) {
      shape = moduleShape(p.tree);
      shapes.set(p, shape);
    }
    return shape;
  };

  /**
   * Resolves an import specifier the way Bun does: relative paths, tsconfig "paths" (~/*),
   * workspace packages and package.json "exports". Compiled dependencies map to their .d.ts.
   */
  function resolveSpec(fromPath: string, spec: string): string | null {
    let target: string;
    try {
      target = Bun.resolveSync(spec, dirname(join(root, fromPath)));
    } catch {
      return null;
    }
    if (COMPILED_JS.test(target)) target = typesFor(target) ?? target;
    // Bun returns real paths; the repo root may be reached through a symlink.
    for (const base of [root, realRoot]) {
      const rel = relative(base, target);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return null;
  }

  const moduleTop = (path: string, text: string): Found => ({
    path,
    text,
    sym: {
      name: basename(path),
      kind: "module",
      line: 1,
      endLine: Math.min(SNIPPET_LINES, text.split("\n").length),
      nameLine: 1,
      nameCol: 0,
    },
  });

  /** A name as `path` exports it: declared there, renamed by `export { a as b }`, or re-exported from elsewhere. */
  async function exported(path: string, name: string, seen: Set<string>): Promise<Found | null> {
    const key = `${path}#${name}`;
    if (seen.has(key) || seen.size > 40) return null;
    seen.add(key);
    const p = await parsed(path, "additions");
    if (!p?.parsed) return null;
    const shape = JS_LIKE.test(path) ? shapeOf(p.parsed) : null;
    if (name === "default") {
      const d = shape?.defaultExport;
      if (!d) return null;
      if (d.name) return local(path, d.name, "additions", seen);
      const lines = p.text.split("\n");
      return {
        path,
        text: p.text,
        sym: {
          name: "default",
          kind: "default",
          line: d.line,
          endLine: Math.min(d.line + SNIPPET_LINES - 1, lines.length),
          nameLine: d.line,
          nameCol: 0,
        },
      };
    }
    const declared = p.parsed.symbols.find((s) => s.name === name);
    if (declared) return { path, sym: declared, text: p.text };
    if (!shape) return null;
    const renamed = shape.localExports.get(name);
    if (renamed) {
      const r = await local(path, renamed, "additions", seen);
      if (r) return r;
    }
    for (const re of shape.reexports) {
      const target = resolveSpec(path, re.spec);
      if (!target) continue;
      if (re.namespace === name) {
        const t = await parsed(target, "additions");
        if (t) return moduleTop(target, t.text);
        continue;
      }
      const original = re.names ? re.names.get(name) : name; // export * passes every name through
      if (!original) continue;
      const r = await exported(target, original, seen);
      if (r) return r;
    }
    return null;
  }

  /** A name inside `path`: declared there, or imported (then followed to where it's declared). */
  async function local(path: string, name: string, side: Side, seen: Set<string>): Promise<Found | null> {
    const p = await parsed(path, side);
    if (!p?.parsed) return null;
    const declared = p.parsed.symbols.find((s) => s.name === name);
    if (declared) return { path, sym: declared, text: p.text };
    const binding = JS_LIKE.test(path) ? shapeOf(p.parsed).imports.get(name) : undefined;
    if (!binding) return null;
    const target = resolveSpec(path, binding.spec);
    if (!target) return null;
    if (binding.imported === "*") {
      const t = await parsed(target, "additions");
      return t ? moduleTop(target, t.text) : null;
    }
    return exported(target, binding.imported, seen);
  }

  /** Follows the import of `name` used on a line (including `ns.name` for `import * as ns`). */
  async function throughImports(name: string, from: { path: string; side: Side; line: number }) {
    if (!JS_LIKE.test(from.path)) return null;
    const p = await parsed(from.path, from.side);
    if (!p?.parsed) return null;
    const shape = shapeOf(p.parsed);
    const ns = namespaceOf(p.parsed.tree, from.line, name);
    const nsBinding = ns ? shape.imports.get(ns) : undefined;
    if (nsBinding?.imported === "*") {
      const target = resolveSpec(from.path, nsBinding.spec);
      return target ? exported(target, name, new Set()) : null;
    }
    return shape.imports.has(name) ? local(from.path, name, from.side, new Set()) : null;
  }

  function snippet(text: string, sym: Sym) {
    const lines = text.split("\n");
    const end = Math.min(sym.endLine, sym.line + SNIPPET_LINES - 1);
    return { snippet: lines.slice(sym.line - 1, end).join("\n"), snippetStart: sym.line };
  }

  async function grep(name: string): Promise<GrepMatch[]> {
    await scanned;
    const r = finder.grep(`\\b${escapeRe(name)}\\b`, {
      mode: "regex",
      smartCase: false,
      classifyDefinitions: true,
      pageSize: 1000,
      maxMatchesPerFile: 200,
      timeBudgetMs: 2000,
    });
    if (!r.ok) return [];
    // Keep exact, case-sensitive whole-word hits only.
    const word = new RegExp(`(^|[^\\p{L}\\p{N}_$])${escapeRe(name)}($|[^\\p{L}\\p{N}_$])`, "u");
    return r.value.items.filter((m) => !m.isBinary && word.test(m.lineContent));
  }

  /** Matches as Claude reads them: by file, definitions marked, lines cut short, a note when there's more. */
  function forClaude(r: ReturnType<typeof finder.grep>, what: string) {
    if (!r.ok) return `Search failed: ${r.error}`;
    const items = r.value.items.filter((m) => !m.isBinary);
    if (!items.length) return `No matches for ${what}.`;
    const out: string[] = [];
    let file = "";
    for (const m of items) {
      if (m.relativePath !== file) {
        file = m.relativePath;
        out.push(file);
      }
      out.push(`  ${m.lineNumber}${m.isDefinition ? " [def]" : ""}: ${m.lineContent.trim().slice(0, 200)}`);
    }
    if (r.value.nextCursor) out.push("(more matches: narrow with a path or *.ext constraint)");
    if (r.value.regexFallbackError) out.unshift(`Not a valid regex, searched as text: ${r.value.regexFallbackError}`);
    return out.join("\n");
  }
  const LIMITS = { pageSize: 60, maxMatchesPerFile: 8, timeBudgetMs: 3000, classifyDefinitions: true };

  return {
    /** Claude's grep: fff's warm index; constraints (`*.ts`, `src/`, `!test/`) go before the text. */
    async grepForClaude(query: string, regex: boolean) {
      await scanned;
      return forClaude(finder.grep(query, { ...LIMITS, mode: regex ? "regex" : "plain" }), JSON.stringify(query));
    },

    /** Claude's multi_grep: any of several literal patterns (name variants), in one pass. */
    async multiGrepForClaude(patterns: string[], constraints?: string) {
      await scanned;
      return forClaude(finder.multiGrep({ ...LIMITS, patterns, constraints }), patterns.join(" | "));
    },

    /** Claude's find_files: fuzzy file names, recently used and changed files first. */
    async findForClaude(query: string) {
      await scanned;
      const r = finder.fileSearch(query, { pageSize: 30 });
      if (!r.ok) return `Search failed: ${r.error}`;
      const files = r.value.items.map((f) => `${f.relativePath}${f.gitStatus !== "clean" ? ` (${f.gitStatus})` : ""}`);
      return files.length ? files.join("\n") : `No files match ${JSON.stringify(query)}.`;
    },

    /**
     * Repo-wide text search through fff's warm index, recently used files first. The query
     * may start with fff's scopes (`*.ts`, `src/`). Lines are cut to 400 characters.
     */
    search(query: string, opts: { regex: boolean; caseSensitive: boolean; after?: string }): SearchResult {
      // The page cursor travels as fff's own cursor object, serialized and handed back unchanged.
      let cursor: GrepCursor | null = null;
      try {
        cursor = opts.after ? (JSON.parse(Buffer.from(opts.after, "base64url").toString()) as GrepCursor) : null;
      } catch {
        return { matches: [], truncated: false, next: null };
      }
      const r = finder.grep(query, {
        cursor,
        mode: opts.regex ? "regex" : "plain",
        smartCase: !opts.caseSensitive,
        pageSize: 200,
        maxMatchesPerFile: 100,
        timeBudgetMs: 1500,
        beforeContext: 2,
        afterContext: 2,
      });
      if (!r.ok) return { matches: [], truncated: false, next: null };
      const matches = r.value.items
        .filter((m) => !m.isBinary)
        .map((m) => {
          const text = m.lineContent.slice(0, 400);
          const cut = (lines: string[] | undefined) => (lines ?? []).map((l) => l.slice(0, 400));
          return {
            path: m.relativePath,
            line: m.lineNumber,
            text,
            before: cut(m.contextBefore),
            after: cut(m.contextAfter),
            ranges: m.matchRanges
              .map(([a, b]) => [charCol(m.lineContent, a), charCol(m.lineContent, b)] as [number, number])
              .filter(([a]) => a < text.length),
          };
        });
      const { nextCursor } = r.value;
      return {
        matches,
        truncated: nextCursor !== null,
        next: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString("base64url") : null,
        ...(r.value.regexFallbackError ? { regexError: r.value.regexFallbackError } : {}),
      };
    },

    async symbols(path: string, prev: string | null, includeOld = true) {
      const [now, before] = await Promise.all([
        parsed(path, "additions"),
        includeOld ? parsed(prev ?? path, "deletions") : Promise.resolve(null),
      ]);
      return { new: now?.parsed?.outline ?? null, old: before?.parsed?.outline ?? null };
    },

    async identifiers(path: string, side: Side, line: number) {
      const p = await parsed(path, side);
      return p?.parsed ? identifiersOnLine(p.parsed, line) : [];
    },

    async identifierAt(path: string, side: Side, line: number, col: number) {
      const p = await parsed(path, side);
      return p?.parsed ? identifierAt(p.parsed, line, col) : null;
    },

    /**
     * Definitions of `name`. An imported name is followed through its import to the one place it's
     * declared. Otherwise: the current file first, then files in the diff, then nearest by path.
     */
    async definition(name: string, from: { path: string; side: Side; line: number }): Promise<Location[]> {
      const diffs = await diffInfo();
      const via = await throughImports(name, from);
      if (via) {
        const lineText = via.text.split("\n")[via.sym.nameLine - 1] ?? "";
        return [
          {
            ...location(via.path, via.sym.nameLine, via.sym.nameCol, lineText, diffs),
            kind: via.sym.kind,
            ...snippet(via.text, via.sym),
          },
        ];
      }
      const matches = await grep(name);
      const byFile = Map.groupBy(matches, (m) => m.relativePath);
      // Candidates: files where fff or a declaration-shaped line suggests a definition. This only
      // picks which files to parse; tree-sitter decides what is actually a definition.
      const declares = new RegExp(
        `(\\b(function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|namespace|impl)\\s+${escapeRe(name)}\\b)|(\\b${escapeRe(name)}\\s*[:=]\\s*(async\\b|\\(|function\\b|<))|(^\\s*(async\\s+|static\\s+|public\\s+|private\\s+|protected\\s+|get\\s+|set\\s+)*\\*?${escapeRe(name)}\\s*[(<])`,
      );
      const likely = [...byFile.keys()].filter((f) =>
        byFile.get(f)?.some((m) => m.isDefinition || declares.test(m.lineContent)),
      );
      const files = [from.path, ...likely];
      const out: Location[] = [];
      const seen = new Set<string>();
      const check = async (file: string, side: Side) => {
        const p = await parsed(file, side);
        for (const sym of p?.parsed?.symbols ?? []) {
          if (sym.name !== name) continue;
          const key = `${file}:${sym.nameLine}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lineText = p!.text.split("\n")[sym.nameLine - 1] ?? "";
          out.push({
            ...location(file, sym.nameLine, sym.nameCol, lineText, diffs),
            kind: sym.kind,
            ...snippet(p!.text, sym),
          });
        }
      };
      await check(from.path, from.side);
      for (const f of [...new Set(files.slice(1))].slice(0, MAX_FILES_CHECKED)) await check(f, "additions");
      if (!out.length) for (const f of [...byFile.keys()].slice(0, MAX_FILES_CHECKED)) await check(f, "additions");
      const shared = (a: string) => {
        let i = 0;
        while (i < a.length && a[i] === from.path[i]) i++;
        return i;
      };
      const isTest = (p: string) => /(^|[/.])(tests?|specs?|__tests__|__mocks__|fixtures?)([/.]|$)/.test(p);
      return out.sort(
        (a, b) =>
          Number(b.path === from.path) - Number(a.path === from.path) ||
          Number(isTest(a.path)) - Number(isTest(b.path)) ||
          Number(b.inDiff) - Number(a.inDiff) ||
          shared(b.path) - shared(a.path) ||
          a.path.localeCompare(b.path),
      );
    },

    /** Uses of `name` in code (not comments or strings), split into lines this diff changed and lines it didn't. */
    async references(name: string) {
      const diffs = await diffInfo();
      const matches = await grep(name);
      const byFile = Map.groupBy(matches, (m) => m.relativePath);
      // A mention in documentation isn't a use. Files without a grammar can't be checked, so
      // anything but docs is kept as a plain text match.
      const docs = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
      const files = [...byFile.keys()]
        .filter((f) => !docs.test(f))
        .sort((a, b) => Number(diffs.has(b)) - Number(diffs.has(a)));
      const changed: Location[] = [];
      const untouched: Location[] = [];
      // Matches in files nit has no grammar for can't be checked; they're reported apart.
      const text: Location[] = [];
      for (const file of files.slice(0, MAX_FILES_CHECKED)) {
        const p = await parsed(file, "additions");
        const defs = new Set(p?.parsed?.symbols.filter((s) => s.name === name).map((s) => s.nameLine));
        for (const m of byFile.get(file) ?? []) {
          const start = m.matchRanges[0]?.[0] ?? m.col;
          const col = charCol(m.lineContent, start);
          const loc = {
            ...location(file, m.lineNumber, col, m.lineContent, diffs),
            kind: defs.has(m.lineNumber) ? "definition" : undefined,
          };
          if (!p?.parsed) {
            text.push(loc);
            continue;
          }
          if (identifierAt(p.parsed, m.lineNumber, col) !== name) continue;
          (loc.changed ? changed : untouched).push(loc);
        }
      }
      return { changed, untouched, text, truncated: files.length > MAX_FILES_CHECKED };
    },

    destroy: () => finder.destroy(),
  };
}

export type Navigator = Awaited<ReturnType<typeof createNavigator>>;
