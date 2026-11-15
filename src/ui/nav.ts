import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side, Symbol as Sym } from "../types";
import { api } from "./api";
import { rows } from "./lines";
import * as st from "./state";

// ---------- where you are lives in the URL; browser history is the back stack (⌘[)

// ?file=a/b.ts&line=42 (&side=old for a removed line, &whole for the full file), or
// ?open=c/d.ts&line=7 for a file outside the review, ?search=text(&regex&case) for the search
// screen. Other parameters (?debug) are kept.
const KEYS = ["file", "open", "line", "side", "whole", "search", "regex", "case"];

function placeUrl() {
  const { browse, cursor, fullFiles, searchOpen, search: find } = st.get();
  const f = st.currentFile();
  const q = new URLSearchParams(location.search);
  for (const k of KEYS) q.delete(k);
  if (searchOpen) {
    q.set("search", find.query);
    if (find.regex) q.set("regex", "");
    if (find.caseSensitive) q.set("case", "");
  } else if (browse) {
    q.set("open", browse.path);
    q.set("line", String(browse.line));
  } else if (f) {
    q.set("file", f.name);
    if (cursor) q.set("line", String(cursor.line));
    if (cursor?.side === "deletions") q.set("side", "old");
    if (fullFiles.has(f.name)) q.set("whole", "");
  }
  // Bare flags (?whole, ?debug), and paths with readable slashes.
  const search = q
    .toString()
    .replace(/=(&|$)/g, "$1")
    .replaceAll("%2F", "/");
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

let applying = false;
let urlTimer: ReturnType<typeof setTimeout> | undefined;
/** Rewrites the current history entry; cursor moves are coalesced so j/k stays cheap. */
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = undefined;
  if (applying || !st.get().files.length) return;
  const url = placeUrl();
  if (url !== `${location.pathname}${location.search}`) history.replaceState(history.state, "", url);
}
st.subscribeToStore(() => {
  if (urlTimer === undefined) urlTimer = setTimeout(syncUrl, 120);
});

/** Before a jump: the current entry keeps where you were, and a new entry takes the jump. */
function remember() {
  syncUrl();
  const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
  history.pushState({ depth }, "", location.href);
}

/** ⌘[ is the browser's Back, so both survive a reload; it never leaves nit. */
export function goBack() {
  if (((history.state as { depth?: number } | null)?.depth ?? 0) > 0) history.back();
  else if (st.get().browse) st.set({ browse: null, peek: null });
}

/** Opens the file you're on, at your line, in your editor (the editor command in settings). */
export async function openInEditor() {
  const { browse, cursor } = st.get();
  const file = st.currentFile();
  // A removed line isn't in your copy of the file: open it at the top.
  const at = browse
    ? { path: browse.path, line: browse.line }
    : file
      ? { path: file.name, line: cursor?.side === "additions" ? cursor.line : 1 }
      : null;
  if (!at) return;
  try {
    await api.openInEditor(at.path, at.line);
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't open your editor.");
  }
}

/** The search screen is a place too: Back from a result you opened returns to it. */
export function openSearch() {
  if (st.get().searchOpen) return;
  remember();
  st.set({ searchOpen: true, palette: null, peek: null });
}

export function closeSearch() {
  if (!st.get().searchOpen) return;
  if (((history.state as { depth?: number } | null)?.depth ?? 0) > 0) history.back();
  else st.set({ searchOpen: false });
}

/** Puts you where the URL says: on load, and on Back/Forward. */
export async function applyUrl() {
  const q = new URLSearchParams(location.search);
  const line = Number(q.get("line")) || 0;
  const open = q.get("open");
  const file = q.get("file");
  applying = true;
  try {
    if (q.has("search")) {
      st.set({
        searchOpen: true,
        search: { query: q.get("search") ?? "", regex: q.has("regex"), caseSensitive: q.has("case") },
      });
      return;
    }
    if (st.get().searchOpen) st.set({ searchOpen: false });
    if (open) {
      st.set({ browse: { path: open, line: line || 1, lines: 0 }, peek: null, anchor: null, focused: null });
      return;
    }
    const index = file ? st.get().files.findIndex((f) => f.name === file) : -1;
    if (index === -1) return void (st.get().browse && st.set({ browse: null, peek: null }));
    st.openFile(index);
    if (q.has("whole")) await st.setFullFile(file as string, true);
    if (line) await goToLine(index, q.get("side") === "old" ? "deletions" : "additions", line, false);
  } finally {
    applying = false;
  }
}
window.addEventListener("popstate", () => void applyUrl());

// ---------- outlines

const pending = new Map<string, { patch: string | undefined; oldLoaded: boolean; promise: Promise<void> }>();

/** Fetches a file's symbols once per file version (the store clears them on reload). */
export function loadOutline(path: string, prevName?: string, includeOld = true) {
  const patch = st.get().data?.patch;
  const cached = st.get().outlines[path];
  if (cached && (cached.oldLoaded || !includeOld)) return;
  const inFlight = pending.get(path);
  if (inFlight && inFlight.patch === patch && (inFlight.oldLoaded || !includeOld)) return;
  const p = api
    .symbols(path, prevName, includeOld)
    .then((o) => {
      if (st.get().data?.patch !== patch) return;
      st.set((s) => {
        if (s.outlines[path]?.oldLoaded && !includeOld) return {};
        return { outlines: { ...s.outlines, [path]: { ...o, oldLoaded: includeOld } } };
      });
    })
    .catch(() => {
      if (st.get().data?.patch !== patch || st.get().outlines[path]) return;
      st.set((s) => ({ outlines: { ...s.outlines, [path]: { new: null, old: null, oldLoaded: includeOld } } }));
    })
    .finally(() => {
      if (pending.get(path)?.promise === p) pending.delete(path);
    });
  pending.set(path, { patch, oldLoaded: includeOld, promise: p });
}

/** Symbols that contain a line, outermost first. */
export function enclosing(symbols: Sym[] | null | undefined, line: number) {
  return (symbols ?? [])
    .filter((s) => s.line <= line && line <= s.endLine)
    .sort((a, b) => a.line - b.line || b.endLine - a.endLine);
}

// ---------- lookups

const pathFor = (file: FileDiffMetadata, side: Side) =>
  side === "deletions" ? (file.prevName ?? file.name) : file.name;

/**
 * Go to definition / find references from the cursor line. With several words on the line a
 * picker opens first; ⌘-click passes the clicked column instead.
 */
export async function lookup(mode: "definition" | "references", by?: { name: string } | { col: number }) {
  const file = st.currentFile();
  const { browse } = st.get();
  // In a file outside the review the cursor is the browse line, always on the working copy.
  const cursor: st.Point | null = browse ? { side: "additions", line: browse.line } : st.get().cursor;
  if (!cursor || (!file && !browse)) return;
  const path = browse ? browse.path : pathFor(file as FileDiffMetadata, cursor.side);
  const at = { path, side: cursor.side, line: cursor.line };
  const base = { at: cursor, path: at.path };

  let target = by;
  if (!target || ("col" in target && mode === "references")) {
    st.set({ peek: { ...base, kind: "pick", mode, identifiers: [], status: "loading" } });
    try {
      const ids = await api.identifiers(at);
      const col = target && "col" in target ? target.col : null;
      const hit = col === null ? null : ids.find((i) => col >= i.col && col < i.col + i.name.length);
      if (hit) target = { name: hit.name };
      else if (ids.length === 1) target = { name: ids[0].name };
      else if (!ids.length)
        return st.set({
          peek: { ...base, kind: "pick", mode, identifiers: [], status: "error", error: "No symbol on this line." },
        });
      else return st.set({ peek: { ...base, kind: "pick", mode, identifiers: ids, status: "ready" } });
    } catch (e) {
      return st.set({ peek: { ...base, kind: "pick", mode, identifiers: [], status: "error", error: String(e) } });
    }
  }

  try {
    if (mode === "definition") {
      // Like an editor: one definition is a jump, not a card (read-only when it's outside
      // the review). The loading card
      // only shows if the lookup is slow, so a jump doesn't flash one.
      const name = "name" in target ? target.name : null;
      const slow = setTimeout(
        () => st.set({ peek: { ...base, kind: "definition", name, results: [], status: "loading" } }),
        150,
      );
      const r = await api.definition(at, target).finally(() => clearTimeout(slow));
      const only = r.results.length === 1 ? r.results[0] : null;
      // ⌘-click on the definition itself: jumping to where you are only redraws the pane, so
      // show who uses it instead, as editors do.
      const here = only && only.path === at.path && only.line === at.line && cursor.side === "additions";
      if (here && (r.name ?? name)) {
        st.set({ peek: null });
        return lookup("references", { name: (r.name ?? name) as string });
      }
      if (only) return openLocation(only);
      st.set({ peek: { ...base, kind: "definition", name: r.name, results: r.results, status: "ready" } });
    } else {
      const name = (target as { name: string }).name;
      st.set({
        peek: {
          ...base,
          kind: "references",
          name,
          changed: [],
          untouched: [],
          text: [],
          truncated: false,
          status: "loading",
        },
      });
      const r = await api.references(name);
      st.set({ peek: { ...base, kind: "references", ...r, status: "ready" } });
    }
  } catch (e) {
    st.set((s) =>
      s.peek ? { peek: { ...s.peek, status: "error", error: e instanceof Error ? e.message : String(e) } } : {},
    );
  }
}

export const closePeek = () => st.set({ peek: null });

/** Puts the cursor on a line of a file in this review, showing the whole file if the line is folded away. */
async function goToLine(index: number, side: Side, line: number, record = true) {
  const files = st.get().files;
  if (record) remember();
  st.openFile(index); // also leaves a file opened outside the review
  const path = files[index].name;
  const visible = rows(st.get().files[index], st.get().fullFiles.has(path)).some(
    (x) => x.side === side && x.line === line,
  );
  if (!visible && side === "additions") await st.setFullFile(path, true);
  st.set({ cursor: { side, line }, anchor: null, peek: null, focused: null });
}

/** Goes to a line on either side of a file in the review (a removed line is on the old side). */
export const goTo = (index: number, side: Side, line: number) => goToLine(index, side, line);

/** Moves to a location: in the review's diff when the file is part of it, else read-only. */
export function openLocation(loc: { path: string; line: number }) {
  const index = st.get().files.findIndex((f) => f.name === loc.path);
  if (index !== -1) return void goToLine(index, "additions", loc.line);
  remember();
  st.set({
    browse: { path: loc.path, line: loc.line, lines: 0 },
    peek: null,
    anchor: null,
    focused: null,
    searchOpen: false,
  });
}

/** Outline click: go to the symbol in the code, unfolding the file if it's outside the changes. */
export async function revealSymbol(sym: Sym, side: Side, changedLine?: number) {
  const line = changedLine ?? sym.nameLine;
  const { browse } = st.get();
  if (browse) return st.set({ browse: { ...browse, line } });
  const index = st.get().current;
  if (st.get().files[index]) await goToLine(index, side, line);
}
