import { type FileDiffMetadata, hydratePartialDiff, parsePatchFiles } from "@pierre/diffs";
import { useSyncExternalStore } from "react";
import {
  type AgentRun,
  type AskThread,
  DEFAULT_PREFS,
  type Draft,
  type FileCategory,
  type FileContents,
  type GitHubState,
  type Job,
  type LinearLink,
  type Location,
  type Prefs,
  type ReviewData,
  type Side,
  type Symbol as Sym,
} from "../types";
import { api } from "./api";
import { inTreeOrder, type Row, rows } from "./lines";
import { toasts } from "./toasts";

export type Point = { side: Side; line: number };
/** Side panel widths in px; saved in nit's database so every repo and reload keeps them. */
export type Widths = { files: number; outline: number };
export const DEFAULT_WIDTHS: Widths = { files: 272, outline: 248 };
/** View preferences, kept in nit's database (browser storage is per port, so per repo). */
type Layout = Widths & { style: Style; sidebar: boolean; outlineOpen: boolean };
const savedLayout = (globalThis as { nitLayout?: Partial<Layout> | null }).nitLayout ?? {};

/** One line of the agent's live activity: a file it read or edited, or something it said. */
export type AgentActivity = { kind: "tool"; tool: string; target: string } | { kind: "text"; text: string };

/** A file outside the review, opened read-only from a definition or reference. */
export type Browse = { path: string; line: number; lines: number };
export type Style = "split" | "unified";

/** The inline panel under a line for definitions, references, or picking which word to look up. */
export type Peek = {
  at: Point;
  path: string;
  status: "loading" | "ready" | "error";
  error?: string;
} & (
  | { kind: "pick"; mode: "definition" | "references"; identifiers: { name: string; col: number }[] }
  | { kind: "definition"; name: string | null; results: Location[] }
  | {
      kind: "references";
      name: string;
      changed: Location[];
      untouched: Location[];
      text: Location[];
      truncated: boolean;
    }
);

export type Outline = { new: Sym[] | null; old: Sym[] | null; oldLoaded: boolean };

export type State = {
  data: ReviewData | null;
  error: string | null;
  files: FileDiffMetadata[];
  current: number;
  style: Style;
  sidebar: boolean;
  viewed: Set<string>;
  /** Changed files that aren't the change itself (generated, tests, docs). */
  categories: Record<string, FileCategory>;
  /** Files you marked viewed that have changed since: to look at again. */
  changedSinceViewed: Set<string>;
  /** The file whose diff shows only what changed since you viewed it. */
  sinceViewed: string | null;
  drafts: Draft[];
  /** Where the line cursor is, and where a range started (shift + arrows). */
  cursor: Point | null;
  anchor: Point | null;
  editing: string | null;
  focused: string | null;
  saving: Record<string, "saving" | "error">;
  palette: "all" | "files" | "symbols" | null;
  peek: Peek | null;
  /** Symbols per file path, from the server's tree-sitter parse. */
  outlines: Record<string, Outline>;
  outlineOpen: boolean;
  /** The review sheet: every draft by file, before posting. */
  reviewOpen: boolean;
  settingsOpen: boolean;
  /** The settings section shown, kept between openings. */
  settingsSection: "appearance" | "diff" | "reviewer" | "github" | "linear" | "commands";
  /** The search screen replaces the diff; its query lives in the URL (?search=…). */
  searchOpen: boolean;
  search: { query: string; regex: boolean; caseSensitive: boolean };
  /** The search text stays marked in the code you open from it, until Esc. */
  marking: boolean;
  /** Claude needs signing in; `retry` reruns what failed once it is. */
  signIn: { retry: (() => void) | null } | null;
  /** Your preferences (the settings screen), saved for every review. */
  prefs: Prefs;
  /** Conversations with Claude in this review, newest first. */
  asks: AskThread[];
  browse: Browse | null;
  /** The agent's current or last pass (agent.ts on the server), its live activity, the panel. */
  agent: AgentRun | null;
  agentActivity: AgentActivity[];
  agentOpen: boolean;
  /** The pull request drawer: description, checks, the Linear issue. */
  prOpen: boolean;
  /** Where the Review sheet opens: at your questions, from the sidebar's button. */
  reviewAt: "questions" | null;
  /** Claude's co-review or question in progress, or the last one. */
  job: Job | null;
  /** The lines an "Ask Claude" box is open on, before (or between) questions. */
  /** The ask box's lines; `thread` shows that conversation (one reopened from the list). */
  asking: { path: string; side: Side; start: number; end: number; thread?: string } | null;
  /** "agent" shows only the last pass's changes instead of the review's diff. */
  view: "review" | "agent";
  /** A draft's lines being edited in the diff to make its suggestion (suggest.ts). */
  suggesting: { draftId: string; path: string; start: number; end: number; ending: boolean } | null;
  widths: Widths;
  /** The pull request and its existing threads; null until the first answer from the server. */
  github: GitHubState | null;
  /** The Linear issue this branch is for. */
  linear: LinearLink | null;
  /** Files shown whole (every unchanged line expanded), by path. */
  fullFiles: Set<string>;
};

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

// Before preferences moved to the database they lived in browser storage; read once as a fallback.
const storedStyle = (): Style => savedLayout.style ?? (stored("nit.style") === "unified" ? "unified" : "split");

let state: State = {
  data: null,
  error: null,
  files: [],
  current: 0,
  style: storedStyle(),
  sidebar: savedLayout.sidebar ?? true,
  viewed: new Set(),
  changedSinceViewed: new Set(),
  sinceViewed: null,
  categories: {},
  drafts: [],
  cursor: null,
  anchor: null,
  editing: null,
  focused: null,
  saving: {},
  palette: null,
  peek: null,
  outlines: {},
  outlineOpen: savedLayout.outlineOpen ?? stored("nit.outline") !== "0",
  reviewOpen: false,
  settingsOpen: false,
  settingsSection: "appearance",
  searchOpen: false,
  search: { query: "", regex: false, caseSensitive: false },
  marking: false,
  signIn: null,
  asks: [],
  prefs: { ...DEFAULT_PREFS, ...(globalThis as { nitPrefs?: Partial<Prefs> | null }).nitPrefs },
  browse: null,
  agent: null,
  agentActivity: [],
  agentOpen: false,
  prOpen: false,
  reviewAt: null,
  job: null,
  asking: null,
  view: "review",
  suggesting: null,
  widths: { files: savedLayout.files ?? DEFAULT_WIDTHS.files, outline: savedLayout.outline ?? DEFAULT_WIDTHS.outline },
  github: null,
  linear: null,
  fullFiles: new Set(),
};

const listeners = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const useStore = <T>(select: (s: State) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const subscribeToStore = subscribe;

export const currentFile = (s = state) => s.files[s.current];

/** FNV-1a over the text; enough to tell one patch from the next. */
function hashOf(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ---------- file contents (full old/new text, for context expansion and comment anchors)

const contents = new Map<string, Promise<FileContents>>();
export function fileContents(file: FileDiffMetadata) {
  const key = `${file.prevName ?? ""}>${file.name}`;
  let p = contents.get(key);
  if (!p) {
    p = api.file(file.name, file.prevName);
    p.catch(() => contents.delete(key));
    contents.set(key, p);
  }
  return p;
}

/** Swaps a parsed patch for one that also carries both files' full text, so unchanged lines can expand. */
export async function hydrate(index: number) {
  const file = state.files[index];
  if (!file?.isPartial) return;
  try {
    const c = await fileContents(file);
    const newFile = { name: file.name, contents: c.new ?? "" };
    const full = hydratePartialDiff(
      "clone",
      file,
      c.old === null
        ? { oldFile: null, newFile }
        : { oldFile: { name: file.prevName ?? file.name, contents: c.old }, newFile },
    );
    set((s) => (s.files[index] === file ? { files: s.files.map((f, i) => (i === index ? full : f)) } : {}));
  } catch {
    // The patch alone still renders; only context expansion is lost.
  }
}

const hydrateAround = (i: number) => {
  void hydrate(i);
  void hydrate(i + 1);
};

// ---------- loading

export async function load() {
  try {
    const requested = Date.now();
    const data = await api.review(state.prefs.hideWhitespace);
    // Coming back to the tab reloads; an unchanged patch keeps the hydrated files and outlines.
    const same = data.patch === state.data?.patch;
    if (!same) contents.clear();
    // In tree order, so next/previous file walks the sidebar top to bottom.
    const files = same
      ? state.files
      : // Keys that change with the patch let the highlight pool reuse work when you switch back.
        inTreeOrder(
          parsePatchFiles(data.patch, { cacheKeyPrefix: `p${hashOf(data.patch)}` })
            .flatMap((p) => p.files)
            // A new or deleted file's patch already holds every line of it. Pierre won't hydrate
            // those (and needn't); left partial, suggestions and the whole-file view refused them.
            .map((f) => (f.type === "new" || f.type === "deleted" ? { ...f, isPartial: false } : f)),
        );
    const before = currentFile()?.name;
    set((s) => {
      // On first load, the first file the list shows: not a lockfile it sets aside.
      const shown = (f: FileDiffMetadata) =>
        !hiddenFile(f.name, { ...s, categories: data.categories, viewed: new Set(data.viewed) });
      const current = Math.max(0, before ? files.findIndex((f) => f.name === before) : files.findIndex(shown));
      // The newer copy of each draft wins. A local draft the server doesn't list is kept if it
      // is unsaved, open, or changed after this request started (the response may predate its save).
      const listed = data.drafts.filter((d) => !deleted.has(d.id)); // deletions still in flight
      const server = new Map(listed.map((d) => [d.id, d]));
      const local = new Map(s.drafts.map((d) => [d.id, d]));
      const drafts = [
        ...listed.map((d) => {
          const mine = local.get(d.id);
          return mine && (unsaved.has(d.id) || mine.updatedAt > d.updatedAt) ? mine : d;
        }),
        ...s.drafts.filter(
          (d) =>
            !server.has(d.id) &&
            // A new comment isn't saved until it has text; while its suggestion is being typed
            // into the diff it isn't the one open either, but it's still yours.
            (unsaved.has(d.id) || d.id === s.editing || d.id === s.suggesting?.draftId || d.updatedAt >= requested),
        ),
      ];
      return {
        data,
        files,
        current,
        drafts,
        viewed: new Set(data.viewed),
        changedSinceViewed: new Set(data.changedSinceViewed),
        categories: data.categories,
        asks: data.asks,
        outlines: same ? s.outlines : {}, // changed files re-read their symbols on demand
        error: null,
      };
    });
    const file = currentFile();
    // A whole-file view needs the full text before its lines exist to keep the cursor on.
    if (file && state.fullFiles.has(file.name)) await hydrate(state.current);
    if (currentFile()?.name !== before || rowIndex(fileRows(), state.cursor) === -1) resetCursor();
    hydrateAround(state.current);
    unfoldForDrafts(state.current);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------- navigation

const fileRows = (s = state): Row[] => {
  const f = currentFile(s);
  return f ? rows(f, s.fullFiles.has(f.name)) : [];
};

function resetCursor() {
  const r = fileRows();
  const first = r.find((x) => x.changeStart) ?? r[0];
  set({
    cursor: first ? { side: first.side, line: first.line } : null,
    anchor: null,
    editing: null,
  });
}

/** Drafts are never hidden: a file with one on a folded line opens whole. */
function unfoldForDrafts(index: number) {
  const f = state.files[index];
  if (!f || state.fullFiles.has(f.name)) return;
  const visible = new Set(rows(f).map((r) => `${r.side}:${r.line}`));
  const hidden = state.drafts.some(
    (d) => d.path === f.name && !d.replyTo && d.start > 0 && !visible.has(`${d.side}:${d.end}`),
  );
  if (hidden) void setFullFile(f.name, true);
}

export function openFile(index: number) {
  if (index < 0 || index >= state.files.length) return;
  if (state.searchOpen) set({ searchOpen: false });
  if (index === state.current) {
    if (state.browse) set({ browse: null, peek: null }); // back to the review's copy of the file
    return;
  }
  set({ current: index, focused: null, browse: null, peek: null });
  resetCursor();
  hydrateAround(index);
  unfoldForDrafts(index);
}

const rowIndex = (r: Row[], p: Point | null) => (p ? r.findIndex((x) => x.side === p.side && x.line === p.line) : -1);

export function moveCursor(delta: number, extend = false) {
  const b = state.browse;
  if (b) return set({ browse: { ...b, line: Math.min(Math.max(1, b.line + delta), Math.max(1, b.lines)) } });
  const r = fileRows();
  if (!r.length) return;
  const i = Math.min(r.length - 1, Math.max(0, rowIndex(r, state.cursor) + delta));
  const next = { side: r[i].side, line: r[i].line };
  set((s) => ({
    cursor: next,
    anchor: extend ? (s.anchor ?? s.cursor) : null,
    focused: null,
  }));
}

export function nextChange(direction: 1 | -1) {
  const r = fileRows();
  const at = rowIndex(r, state.cursor);
  const starts = r.map((x, i) => (x.changeStart ? i : -1)).filter((i) => i >= 0);
  const target = direction > 0 ? starts.find((i) => i > at) : starts.reverse().find((i) => i < at);
  if (target !== undefined)
    set({
      cursor: { side: r[target].side, line: r[target].line },
      anchor: null,
    });
}

const samePoint = (a: Point | null, b: Point | null) => a?.side === b?.side && a?.line === b?.line;

export function setSelection(start: Point, end: Point) {
  // Pierre reports the selection back when nit moves the cursor itself; that echo isn't a user
  // action and must not clear the focused comment.
  const single = start.side === end.side && start.line === end.line;
  if (samePoint(state.cursor, end) && (single ? state.anchor === null : samePoint(state.anchor, start))) return;
  set({
    anchor: start.side === end.side && start.line === end.line ? null : start,
    cursor: end,
    focused: null,
  });
}

/** The commented range: one side, lines start..end. Mixed-side ranges keep the additions side. */
export function selection(s = state): { side: Side; start: number; end: number } | null {
  if (!s.cursor) return null;
  if (!s.anchor) return { side: s.cursor.side, start: s.cursor.line, end: s.cursor.line };
  const r = fileRows(s);
  const [a, b] = [rowIndex(r, s.anchor), rowIndex(r, s.cursor)].sort((x, y) => x - y);
  const picked = r.slice(a, b + 1);
  const side: Side = picked.some((x) => x.side === "additions") ? "additions" : "deletions";
  const lines = picked.filter((x) => x.side === side).map((x) => x.line);
  return { side, start: Math.min(...lines), end: Math.max(...lines) };
}

// ---------- view

export function toggleStyle() {
  set({ style: state.style === "split" ? "unified" : "split" });
}

/** Marks several files viewed or not at once (a folder from the tree's menu). */
export function setViewed(paths: string[], viewed: boolean) {
  const next = new Set(state.viewed);
  const changed = new Set(state.changedSinceViewed);
  for (const p of paths) {
    viewed ? next.add(p) : next.delete(p);
    if (viewed) changed.delete(p);
  }
  set({ viewed: next, changedSinceViewed: changed, sinceViewed: null });
  Promise.all(paths.map((p) => api.setViewed(p, viewed))).catch(() =>
    fail("Couldn't save viewed state. Is nit still running?"),
  );
}

export function toggleViewed(advance = true) {
  const file = currentFile();
  if (!file) return;
  const viewed = new Set(state.viewed);
  const now = !viewed.has(file.name);
  if (now) viewed.add(file.name);
  else viewed.delete(file.name);
  const changedSinceViewed = new Set(state.changedSinceViewed);
  if (now) changedSinceViewed.delete(file.name);
  set({ viewed, changedSinceViewed, sinceViewed: null });
  api.setViewed(file.name, now).catch(() => fail("Couldn't save viewed state. Is nit still running?"));
  if (now && advance) {
    const next = (f: FileDiffMetadata) => !viewed.has(f.name) && !hiddenFile(f.name);
    // The next unviewed file after this one in the list's order, wrapping around.
    const order = fileOrder();
    const k = order.indexOf(state.current);
    const pick = [...order.slice(k + 1), ...order.slice(0, k + 1)].find((i) => next(state.files[i]));
    if (pick !== undefined) openFile(pick);
  }
}

/** The last undoable action. ⌘Z still works after its toast has gone. */
let lastUndo: (() => void) | null = null;
let lastUndoToast: string | null = null;

export function toast(message: string, undo?: () => void) {
  if (undo) lastUndo = undo;
  const id = toasts.add({
    title: message,
    timeout: 4000,
    actionProps: undo ? { children: "Undo", onClick: () => runUndo() } : undefined,
    data: { undo: !!undo },
  });
  if (undo) lastUndoToast = id;
}
/** A toast with an action button (e.g. "Open" after posting). */
/** Something went wrong: shown longer, with a warning mark, and wrapped instead of cut off. */
export function fail(message: string) {
  toasts.add({ title: message, timeout: 8000, data: { error: true } });
}

let savePrefs: ReturnType<typeof setTimeout> | undefined;
/** Changes preferences at once and saves them shortly after (a slider sends one save, not twenty). */
export function setPrefs(patch: Partial<Prefs>) {
  const respace = "hideWhitespace" in patch && patch.hideWhitespace !== state.prefs.hideWhitespace;
  set((s) => ({ prefs: { ...s.prefs, ...patch } }));
  if (respace) void load(); // a different diff to read
  clearTimeout(savePrefs);
  savePrefs = setTimeout(
    () => api.savePrefs(state.prefs).catch(() => fail("Couldn't save your settings. Is nit still running?")),
    300,
  );
}

/** Who answers questions, orders the files and co-reviews, by name. */
export const reviewerName = (s: State = state) => (s.prefs.reviewer === "codex" ? "Codex" : "Claude");

/** Whether the file list sets this file aside (Hide generated / tests / docs / viewed). */
export function hiddenFile(name: string, s: State = state) {
  const c = s.categories[name];
  return (
    (c === "generated" && s.prefs.hideGenerated) ||
    (c === "test" && s.prefs.hideTests) ||
    (c === "docs" && s.prefs.hideDocs) ||
    (c === "formatting" && s.prefs.hideWhitespace) ||
    (s.prefs.hideViewed && s.viewed.has(name))
  );
}

/** j / k: the next or previous file the list shows, skipping the ones set aside. */
export function stepFile(dir: 1 | -1) {
  const order = fileOrder();
  for (let k = order.indexOf(state.current) + dir; k >= 0 && k < order.length; k += dir)
    if (!hiddenFile(state.files[order[k]].name)) return openFile(order[k]);
}

/** The file list as `files` indices, in the order it shows them: Claude's guide when it's on. */
export function fileOrder(s: State = state): number[] {
  const guide = s.prefs.guided ? s.data?.guide : null;
  if (!guide) return s.files.map((_, i) => i);
  const at = new Map(s.files.map((f, i) => [f.name, i]));
  return guide.flatMap((c) => c.files.flatMap((name) => at.get(name) ?? []));
}

/** The current conversation about exactly these lines, if there is one (outdated ones aren't). */
export function threadAt(at: { path: string; side: Side; start: number; end: number } | null) {
  return at
    ? state.asks.find(
        (t) => !t.outdated && t.path === at.path && t.side === at.side && t.start === at.start && t.end === at.end,
      )
    : undefined;
}

/** Forgets a conversation with Claude. */
export function deleteAsk(id: string) {
  set((s) => ({ asks: s.asks.filter((t) => t.id !== id) }));
  api.deleteAsk(id).catch(() => fail("Couldn't delete it. Is nit still running?"));
}

export function notify(message: string, action?: { label: string; run: () => void }) {
  toasts.add({
    title: message,
    timeout: 6000,
    actionProps: action ? { children: action.label, onClick: action.run } : undefined,
  });
}
export const canUndo = () => lastUndo !== null;
function runUndo() {
  const fn = lastUndo;
  lastUndo = null;
  if (lastUndoToast) toasts.close(lastUndoToast);
  lastUndoToast = null;
  fn?.();
}
export const undo = runUndo;

// ---------- drafts

/** Draft ids with changes the server hasn't confirmed yet. */
const unsaved = new Set<string>();
/** Draft ids deleted here; a reload already in flight must not bring them back. */
const deleted = new Set<string>();
const backupPrefix = () => `nit.draft.${state.data?.branch ?? ""}.`;
const backupKey = (id: string) => backupPrefix() + id;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function persist(d: Draft, delay = 300) {
  clearTimeout(timers.get(d.id));
  unsaved.add(d.id);
  try {
    localStorage.setItem(backupKey(d.id), JSON.stringify(d));
  } catch {}
  timers.set(
    d.id,
    setTimeout(async () => {
      set((s) => ({ saving: { ...s.saving, [d.id]: "saving" } }));
      try {
        await api.saveDraft(d);
        if (state.drafts.find((x) => x.id === d.id)?.updatedAt === d.updatedAt) unsaved.delete(d.id);
        try {
          localStorage.removeItem(backupKey(d.id));
        } catch {}
        set((s) => {
          const { [d.id]: _, ...saving } = s.saving;
          return { saving };
        });
      } catch {
        set((s) => ({ saving: { ...s.saving, [d.id]: "error" } }));
        persist(d, 3000); // keep retrying; the text is also in localStorage
      }
    }, delay),
  );
}

const hasContent = (d: Draft) => d.body.trim() !== "" || d.suggestion !== null;

/** A comment on the whole file rather than on lines (line 0, shown above the first change). */
export function startFileComment() {
  const file = currentFile();
  if (!file) return;
  const existing = state.drafts.find((d) => d.path === file.name && d.start === 0);
  if (existing) return set({ editing: existing.id, focused: existing.id });
  const now = Date.now();
  const draft: Draft = {
    id: crypto.randomUUID(),
    path: file.name,
    side: "additions",
    start: 0,
    end: 0,
    body: "",
    suggestion: null,
    anchor: [],
    createdAt: now,
    updatedAt: now,
  };
  set((s) => ({ drafts: [...s.drafts, draft], editing: draft.id, focused: draft.id }));
}

/** Opens the composer at once; the commented lines' text is filled in when the file contents arrive. */
export function startComment() {
  const file = currentFile();
  const sel = selection();
  if (!file || !sel) return;
  const existing = state.drafts.find(
    (d) => d.path === file.name && d.side === sel.side && d.start === sel.start && d.end === sel.end,
  );
  if (existing) return set({ editing: existing.id, focused: existing.id });
  const now = Date.now();
  const draft: Draft = {
    id: crypto.randomUUID(),
    path: file.name,
    side: sel.side,
    start: sel.start,
    end: sel.end,
    body: "",
    suggestion: null,
    anchor: [],
    createdAt: now,
    updatedAt: now,
  };
  set((s) => ({
    drafts: [...s.drafts, draft],
    editing: draft.id,
    focused: draft.id,
    anchor: null,
  }));
  fileContents(file).then(
    (text) => {
      const source = (sel.side === "additions" ? text.new : text.old) ?? "";
      const anchor = source.split("\n").slice(sel.start - 1, sel.end);
      set((s) => ({
        drafts: s.drafts.map((d) => (d.id === draft.id ? { ...d, anchor } : d)),
      }));
      const d = state.drafts.find((x) => x.id === draft.id);
      if (d && hasContent(d)) persist(d);
    },
    () => fail("Couldn't read the file. The comment is saved without its line text."),
  );
}

export function updateDraft(id: string, patch: Partial<Pick<Draft, "body" | "suggestion">>) {
  const current = state.drafts.find((d) => d.id === id);
  if (!current) return;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? next : d)) }));
  if (hasContent(next)) persist(next);
}

/** Replaces a draft wholesale and saves it now (accepting Claude's proposal). */
export function replaceDraft(next: Draft) {
  set((s) => ({ drafts: s.drafts.map((d) => (d.id === next.id ? next : d)) }));
  persist({ ...next, updatedAt: Date.now() }, 0);
}

export function finishEditing() {
  const d = state.drafts.find((x) => x.id === state.editing);
  set({ editing: null });
  if (d && !hasContent(d)) removeDraft(d.id, false);
}

export function editDraft(id: string) {
  const d = state.drafts.find((x) => x.id === id);
  if (d) set({ editing: id, focused: id });
}

export function removeDraft(id: string, offerUndo = true) {
  const d = state.drafts.find((x) => x.id === id);
  if (!d) return;
  clearTimeout(timers.get(id));
  unsaved.delete(id);
  set((s) => ({
    drafts: s.drafts.filter((x) => x.id !== id),
    focused: null,
    editing: s.editing === id ? null : s.editing,
  }));
  deleted.add(id);
  api.deleteDraft(id).then(
    () => deleted.delete(id),
    () => {},
  );
  try {
    localStorage.removeItem(backupKey(id));
  } catch {}
  if (offerUndo && hasContent(d))
    toast("Comment deleted", () => {
      deleted.delete(id);
      set((s) => ({ drafts: [...s.drafts, d], focused: d.id }));
      persist(d, 0);
    });
}

export async function applySuggestion(id: string) {
  const d = state.drafts.find((x) => x.id === id);
  if (!d?.suggestion) return;
  clearTimeout(timers.get(id));
  try {
    await api.saveDraft(d);
    await api.applySuggestion(id);
    toast(`Suggestion applied to ${d.path.split("/").pop()}`);
    await load();
  } catch (e) {
    fail(e instanceof Error ? e.message : "Couldn't apply the suggestion.");
  }
}

/** Drafts in review order: by file position, then line. */
export function orderedDrafts(s = state) {
  const order = new Map(s.files.map((f, i) => [f.name, i]));
  return [...s.drafts].sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9) || a.start - b.start);
}

/** Opens a draft's file and puts the cursor and focus on it. */
export function focusDraft(id: string) {
  const d = state.drafts.find((x) => x.id === id);
  if (!d) return;
  const index = state.files.findIndex((f) => f.name === d.path);
  if (index !== -1 && index !== state.current) {
    set({ current: index });
    void hydrate(index);
  }
  set({
    focused: d.id,
    cursor: d.start === 0 ? state.cursor : { side: d.side, line: d.end },
    anchor: null,
    editing: null,
    peek: null,
  });
}

export function jumpDraft(direction: 1 | -1) {
  const list = orderedDrafts();
  if (!list.length) return;
  const at = list.findIndex((d) => d.id === state.focused);
  const next = list[(at + direction + list.length) % list.length] ?? list[0];
  const index = state.files.findIndex((f) => f.name === next.path);
  if (index !== -1 && index !== state.current) {
    set({ current: index });
    hydrateAround(index);
  }
  set({
    focused: next.id,
    cursor: { side: next.side, line: next.end },
    anchor: null,
    editing: null,
  });
}

/** Offline backups left by a crash or a stopped server get restored on load. */
export function restoreBackups() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(backupPrefix())) continue;
      const d = JSON.parse(localStorage.getItem(key)!) as Draft;
      if (!state.drafts.some((x) => x.id === d.id)) set((s) => ({ drafts: [...s.drafts, d] }));
      persist(d, 0);
    }
  } catch {}
}

// ---------- GitHub

/** Loads the pull request and its threads without blocking anything else. */
export async function loadGitHub(fresh = false) {
  try {
    set({ github: await api.github(fresh) });
    set({ linear: await api.linear() }); // reads the PR's title and description
  } catch {
    // The server is unreachable; local review keeps working.
  }
}

/** Resolve or reopen a thread: the screen changes at once, and changes back if GitHub refuses. */
export async function setThreadResolved(id: string, resolved: boolean) {
  const flip = (to: boolean) =>
    set((s) =>
      s.github?.status === "ready"
        ? { github: { ...s.github, threads: s.github.threads.map((t) => (t.id === id ? { ...t, resolved: to } : t)) } }
        : {},
    );
  flip(resolved);
  try {
    await api.resolveThread(id, resolved);
  } catch (e) {
    flip(!resolved);
    fail(e instanceof Error ? e.message : "GitHub didn't accept that.");
  }
}

/** Starts (or reopens) a reply draft on an existing thread. It posts with the review. */
export function replyTo(threadId: string) {
  const gh = state.github;
  const thread = gh?.status === "ready" ? gh.threads.find((t) => t.id === threadId) : undefined;
  if (!thread) return;
  const existing = state.drafts.find((d) => d.replyTo === threadId);
  if (existing) return set({ editing: existing.id, focused: existing.id });
  const now = Date.now();
  const draft: Draft = {
    id: crypto.randomUUID(),
    path: thread.path,
    side: thread.side,
    start: thread.startLine ?? thread.line ?? 0,
    end: thread.line ?? 0,
    body: "",
    suggestion: null,
    anchor: [],
    replyTo: threadId,
    createdAt: now,
    updatedAt: now,
  };
  set((s) => ({ drafts: [...s.drafts, draft], editing: draft.id, focused: draft.id }));
}

/** Shows the whole file, or folds unchanged lines back. Returns once the file has its full text. */
export async function setFullFile(path: string, full: boolean) {
  const index = state.files.findIndex((f) => f.name === path);
  if (index === -1) return;
  if (full) await hydrate(index);
  set((s) => {
    const fullFiles = new Set(s.fullFiles);
    if (full) fullFiles.add(path);
    else fullFiles.delete(path);
    return { fullFiles };
  });
  // Folding back can hide the cursor's line.
  if (!full && rowIndex(fileRows(), state.cursor) === -1) resetCursor();
}

/** A panel can grow until the diff between them would drop below 480px. */
export function maxWidth(panel: keyof Widths) {
  const other =
    panel === "files" ? (state.outlineOpen ? state.widths.outline : 0) : state.sidebar ? state.widths.files : 0;
  return Math.max(200, Math.min(640, window.innerWidth - other - 480));
}

export function setWidth(panel: keyof Widths, px: number) {
  set((s) => ({ widths: { ...s.widths, [panel]: Math.round(px) } }));
}

// Any change to the view preferences saves them, whichever action made it.
const layoutOf = (s: State): Layout => ({
  ...s.widths,
  style: s.style,
  sidebar: s.sidebar,
  outlineOpen: s.outlineOpen,
});
let savedLayoutKey = JSON.stringify(layoutOf(state));
let saveLayout: ReturnType<typeof setTimeout> | undefined;
subscribe(() => {
  const layout = layoutOf(state);
  const key = JSON.stringify(layout);
  if (key === savedLayoutKey) return;
  savedLayoutKey = key;
  clearTimeout(saveLayout);
  saveLayout = setTimeout(() => api.saveLayout(layout).catch(() => {}), 400);
});
