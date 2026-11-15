import {
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type DiffTokenEventBaseProps,
  type FileDiffEditCompleteEvent,
  type FileDiffMetadata,
  parseDiffFromFile,
  type SelectedLineRange,
  type TokenEventBase,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  AlignJustify,
  ArrowRight,
  ChatPlusIn,
  Check,
  Copy,
  EditPencil,
  Expand,
  Link,
  List,
  NavArrowRight,
  OpenNewWindow,
  Page,
  SidebarExpand,
  Sparks,
  ViewColumns2,
} from "iconoir-react/regular";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Side } from "../types";
import { AskAnnotation, AskChip } from "./Ask";
import * as agent from "./agent";
import { type At, api } from "./api";
import { HIGHLIGHTER } from "./Code";
import { DraftAnnotation } from "./Comments";
import { stats } from "./lines";
import { copy, type MenuItem, RightClick, selectedText } from "./Menu";
import * as nav from "./nav";
import { OutlineToggle } from "./Outline";
import { PeekAnnotation } from "./Peek";
import { CheckAnnotationRow } from "./PullRequest";
import * as st from "./state";
import * as suggest from "./suggest";
import { ThreadAnnotation } from "./Threads";
import { useTheme } from "./theme";
import { Button, basename, dirname, IconButton, Segmented, TextSegmented, Toggle, Tooltip } from "./ui";

type Meta =
  | { id: string }
  | { peek: true }
  | { thread: string }
  | { suggesting: true }
  | { asking: true }
  | { ask: string }
  | { ci: string };

// CodeView only updates a controlled item when its version changes.
let nextDiffVersion = 0;

/** Under the lines being edited into a suggestion: what's happening and how to finish. */
function SuggestingBar() {
  const sg = st.useStore((s) => s.suggesting);
  if (!sg) return null;
  return (
    <div className="px-3 py-1.5 font-sans">
      <div className="flex min-h-9 max-w-[780px] flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-surface px-3 py-1.5 text-[12.5px] shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-tint)]">
        <span className="text-ink">
          Suggesting a change to {sg.start === sg.end ? `line ${sg.start}` : `lines ${sg.start}–${sg.end}`}
        </span>
        <span className="text-ink-3">Edit the code above</span>
        <span className="ml-auto flex items-center gap-2">
          <Button tone="ghost" className="h-6 px-2" onClick={() => suggest.finish(false)}>
            Cancel <span className="opacity-70">Esc</span>
          </Button>
          <Button tone="primary" className="h-6 px-2" onClick={() => suggest.finish(true)}>
            Done <span className="opacity-70">{"⌘↵"}</span>
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Pierre draws lines inside a shadow root; find the row for one side + line number. */
function findRow(side: "additions" | "deletions", line: number) {
  const root = document.querySelector("diffs-container")?.shadowRoot;
  const rows = root?.querySelectorAll<HTMLElement>(`[data-line="${line}"]`) ?? [];
  // Pierre's own rule (getAnnotationSide): a change row's type names its side; any other row
  // takes its column's, where only the split view's old column has data-deletions.
  return [...rows].find((r) => {
    const type = r.dataset.lineType;
    if (type === "change-deletion") return side === "deletions";
    if (type === "change-addition") return side === "additions";
    return r.closest("[data-deletions]") ? side === "deletions" : side === "additions";
  });
}

/**
 * Brings the cursor row into view, vertically only (scrollIntoView would also shift a wide split
 * view sideways). Off screen (a jump) centres it; near an edge (j/k) nudges it. A freshly
 * remounted diff draws a frame or two late, so it retries briefly.
 */
export function revealLine(side: "additions" | "deletions", line: number, tries = 10) {
  const el = findRow(side, line);
  const scroller = document.querySelector<HTMLElement>("[data-diff-scroll]");
  if (!el || !scroller) {
    if (tries > 0) requestAnimationFrame(() => revealLine(side, line, tries - 1));
    return;
  }
  const row = el.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const margin = 48;
  if (row.bottom < box.top || row.top > box.bottom)
    scroller.scrollTop += row.top - box.top - (box.height - row.height) / 2;
  else if (row.top < box.top + margin) scroller.scrollTop -= box.top + margin - row.top;
  else if (row.bottom > box.bottom - margin) scroller.scrollTop += row.bottom - (box.bottom - margin);
}

// Inside Pierre's shadow root: the cursor row, quiet separators, the comment gutter button, and
// search marks (ui/marks.ts).
export const DIFF_CSS = `
[data-line][data-selected-line] { box-shadow: inset 2px 0 0 var(--accent), inset 0 0 0 999px var(--accent-tint); }
[data-separator-content] { font-family: var(--diffs-header-font-family); font-size: 12px; letter-spacing: -0.005em; color: var(--ink-3); }
[data-expand-button] { color: var(--ink-3); transition: color 100ms, background-color 100ms; }
@media (hover: hover) { [data-expand-button]:hover { color: var(--ink); background-color: var(--hover-2); } }
[data-gutter-utility-slot] button { background: var(--accent); color: white; border-radius: 6px; box-shadow: 0 1px 2px oklch(0 0 0 / 0.25); }
[data-nit-link] { text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
::highlight(nit-find) { background-color: color-mix(in oklch, var(--orange) 30%, transparent); }
`;

/** ⌘ (Ctrl elsewhere) held over a word underlines it, like an editor's go-to-definition link. */
export const linkKey = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

// The underline follows the key as well as the pointer: pressing ⌘ over a word underlines it at
// once, and letting go removes it. Only identifiers get it (tree-sitter's, per line, asked once),
// like an editor: keywords, strings, comments and punctuation aren't links.
let hovered: { el: Element; at: At; col: number } | null = null;
let held = false;
const lines = new Map<string, Promise<{ name: string; col: number }[]>>();
let linesOf: unknown = null;
function identifiers(at: At) {
  // A reload means the files may have changed; start over.
  if (st.get().data !== linesOf) {
    lines.clear();
    linesOf = st.get().data;
  }
  const key = `${at.side}\0${at.path}\0${at.line}`;
  const p = lines.get(key) ?? api.identifiers(at).catch(() => []);
  lines.set(key, p);
  return p;
}
const symbolAt = async (at: At, col: number) =>
  (await identifiers(at)).some((i) => col >= i.col && col < i.col + i.name.length);

async function paintLink() {
  const h = hovered;
  if (!h) return;
  if (!held) return h.el.removeAttribute("data-nit-link");
  const link = await symbolAt(h.at, h.col);
  if (hovered === h && held) h.el.toggleAttribute("data-nit-link", link);
}
export const tokenLink = {
  enter(el: Element, e: PointerEvent, at: At, col: number) {
    hovered?.el.removeAttribute("data-nit-link");
    hovered = { el, at, col };
    held = linkKey(e);
    void paintLink();
  },
  leave(el: Element) {
    el.removeAttribute("data-nit-link");
    if (hovered?.el === el) hovered = null;
  },
  /** ⌘-click goes to a definition only from an identifier. */
  symbolAt,
};
const onModifier = (e: KeyboardEvent) => {
  if (linkKey(e) === held) return;
  held = linkKey(e);
  void paintLink();
};
window.addEventListener("keydown", onModifier);
window.addEventListener("keyup", onModifier);
window.addEventListener("blur", () => {
  held = false;
  void paintLink();
});

/** Where a token in the review's diff is: the old path for a removed line. */
function tokenAt(side: Side, line: number): At | null {
  const f = st.currentFile();
  return f ? { path: side === "deletions" ? (f.prevName ?? f.name) : f.name, side, line } : null;
}

const toPoint = (side: SelectedLineRange["side"], line: number) => ({ side: side ?? ("additions" as const), line });

const STYLE_OPTIONS = [
  { value: "split" as const, label: "Split", icon: <ViewColumns2 width={14} height={14} />, keys: "s" },
  { value: "unified" as const, label: "Unified", icon: <AlignJustify width={14} height={14} />, keys: "s" },
];

/** A GitHub link to lines of the PR's head commit, when the PR is known. */
function githubLink(path: string, start: number, end: number) {
  const gh = st.get().github;
  if (gh?.status !== "ready") return null;
  const repo = gh.pr.url.replace(/\/pull\/\d+$/, "");
  return `${repo}/blob/${gh.pr.headSha}/${path}#L${start}${end !== start ? `-L${end}` : ""}`;
}

/**
 * Right-click on a line: it becomes the cursor (unless it's inside the selection) and the
 * menu acts on it; on a word, definition and references name it. Cards, text boxes and the
 * suggestion editor keep the browser's menu.
 */
function lineMenu(target: Element): MenuItem[] | null {
  const row = target.closest<HTMLElement>("[data-line]");
  const file = st.currentFile();
  if (!row || !file || target.closest("[contenteditable=true]")) return null;
  const line = Number(row.dataset.line);
  const type = row.dataset.lineType;
  const side: Side =
    type === "change-deletion"
      ? "deletions"
      : type === "change-addition"
        ? "additions"
        : row.closest("[data-deletions]")
          ? "deletions"
          : "additions";
  const sel = st.selection();
  if (!sel || sel.side !== side || line < sel.start || line > sel.end)
    st.set({ cursor: { side, line }, anchor: null, focused: null });
  const range = st.selection() ?? { side, start: line, end: line };
  const word = target.closest<HTMLElement>("[data-char]")?.textContent?.trim() ?? "";
  const name = /^[A-Za-z_$][\w$]*$/.test(word) ? word : null;
  const where = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
  const path = side === "deletions" ? (file.prevName ?? file.name) : file.name;
  const link = side === "additions" ? githubLink(path, range.start, range.end) : null;
  const viewed = st.get().viewed.has(file.name);
  const full = st.get().fullFiles.has(file.name);
  const picked = selectedText(target);
  const items: MenuItem[] = [
    ...(picked
      ? [{ label: "Copy", icon: <Copy />, keys: "Mod+c", run: () => copy(picked, "the selection") }, null]
      : []),
    { label: "Comment", icon: <ChatPlusIn />, keys: "c", run: st.startComment },
    { label: "Ask Claude", icon: <Sparks />, keys: "Mod+i", run: agent.startAsk },
    ...(side === "additions"
      ? [
          {
            label: "Suggest a change",
            icon: <EditPencil />,
            keys: "Mod+Shift+s",
            run: () => {
              st.startComment();
              const id = st.get().editing;
              if (id) void suggest.start(id);
            },
          },
        ]
      : []),
    null,
    ...(name
      ? [
          {
            label: (
              <>
                Go to definition of <code className="font-mono text-[12px] text-ink">{name}</code>
              </>
            ),
            icon: <ArrowRight />,
            keys: "g d",
            run: () => void nav.lookup("definition", { name }),
          },
          {
            label: (
              <>
                Find references to <code className="font-mono text-[12px] text-ink">{name}</code>
              </>
            ),
            icon: <List />,
            keys: "g r",
            run: () => void nav.lookup("references", { name }),
          },
          null,
        ]
      : []),
    {
      label: "Open in editor",
      icon: <OpenNewWindow />,
      keys: "o",
      run: () => void nav.openInEditor(),
    },
    {
      label: range.start === range.end ? "Copy line" : "Copy lines",
      icon: <Copy />,
      run: () =>
        void st.fileContents(file).then((c) => {
          const text = (side === "deletions" ? c.old : c.new) ?? "";
          copy(
            text
              .split("\n")
              .slice(range.start - 1, range.end)
              .join("\n"),
            range.start === range.end ? "the line" : "the lines",
          );
        }),
    },
    {
      label: `Copy ${path.split("/").pop()}:${where}`,
      icon: <Page />,
      run: () => copy(`${path}:${where}`, "the location"),
    },
    ...(link ? [{ label: "Copy GitHub link", icon: <Link />, run: () => copy(link, "the GitHub link") }] : []),
    null,
    {
      label: viewed ? "Mark as not viewed" : "Mark as viewed",
      icon: <Check />,
      keys: "v",
      run: () => st.toggleViewed(),
    },
    {
      label: full ? "Fold unchanged lines" : "Show the whole file",
      icon: <Expand />,
      keys: "f",
      run: () => void st.setFullFile(file.name, !full),
    },
  ];
  return items;
}

/**
 * The file's diff since you marked it viewed: your viewed copy against the file now. Null until
 * loaded, or when nit didn't keep the viewed copy (a file marked before it did).
 */
function useSinceViewed(file: FileDiffMetadata | null, on: boolean) {
  const [diff, setDiff] = useState<FileDiffMetadata | null>(null);
  useEffect(() => {
    setDiff(null);
    if (!file || !on) return;
    let alive = true;
    void Promise.all([api.viewedText(file.name), st.fileContents(file)]).then(([then, now]) => {
      if (!alive) return;
      if (then.text === null || now.new === null) {
        st.set({ sinceViewed: null });
        return st.fail("nit didn't keep this file as you viewed it, so it can't show just what changed.");
      }
      setDiff(
        parseDiffFromFile(
          { name: file.name, contents: then.text, cacheKey: `viewed:${file.name}:${then.text.length}` },
          { name: file.name, contents: now.new },
        ),
      );
    });
    return () => {
      alive = false;
    };
  }, [file, on]);
  return diff;
}

export function DiffPane() {
  const codeView = useRef<CodeViewHandle<Meta, undefined>>(null);
  const file = st.useStore((s) => st.currentFile(s));
  const style = st.useStore((s) => s.style);
  // Pierre throws on expandUnchanged for a partial diff, so only once the file's full text is in.
  const full = st.useStore((s) => (file ? s.fullFiles.has(file.name) && !file.isPartial : false));
  const viewed = st.useStore((s) => (file ? s.viewed.has(file.name) : false));
  const drafts = st.useStore((s) => s.drafts);
  const cursor = st.useStore((s) => s.cursor);
  const anchor = st.useStore((s) => s.anchor);

  const { darkThemeName: darkTheme, lightThemeName: lightTheme, resolvedColorScheme: scheme } = useTheme();

  const prefs = st.useStore((s) => s.prefs);
  const changedSince = st.useStore((s) => (file ? s.changedSinceViewed.has(file.name) : false));
  const sinceOn = st.useStore((s) => !!file && s.sinceViewed === file.name);
  const sinceDiff = useSinceViewed(file, sinceOn);
  const options = useMemo(
    () => ({
      theme: { dark: darkTheme, light: lightTheme },
      themeType: scheme,
      diffStyle: style,
      preferredHighlighter: HIGHLIGHTER,
      expandUnchanged: full,
      diffIndicators: prefs.indicators,
      lineDiffType: prefs.inlineChanges === "word" ? ("word-alt" as const) : prefs.inlineChanges,
      overflow: prefs.wrap ? ("wrap" as const) : ("scroll" as const),
      hunkSeparators: "line-info" as const,
      disableFileHeader: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      controlledSelection: true,
      lineHoverHighlight: "number" as const,
      unsafeCSS: DIFF_CSS,
      onLineSelected: (range: SelectedLineRange | null) => {
        if (range) st.setSelection(toPoint(range.side, range.start), toPoint(range.endSide ?? range.side, range.end));
      },
      onGutterUtilityClick: (range: SelectedLineRange) => {
        st.setSelection(toPoint(range.side, range.start), toPoint(range.endSide ?? range.side, range.end));
        st.startComment();
      },
      onTokenEnter: (t: TokenEventBase | DiffTokenEventBaseProps, e: PointerEvent) => {
        if (!("side" in t)) return;
        const at = tokenAt(t.side, t.lineNumber);
        if (at) tokenLink.enter(t.tokenElement, e, at, t.lineCharStart);
      },
      onTokenLeave: (t: TokenEventBase | DiffTokenEventBaseProps) => tokenLink.leave(t.tokenElement),
      onTokenClick: async (t: TokenEventBase | DiffTokenEventBaseProps, e: MouseEvent) => {
        if (!("side" in t) || !linkKey(e)) return;
        e.preventDefault();
        const at = tokenAt(t.side, t.lineNumber);
        if (!at || !(await tokenLink.symbolAt(at, t.lineCharStart))) return;
        st.set({ cursor: { side: t.side, line: t.lineNumber }, anchor: null });
        void nav.lookup("definition", { col: t.lineCharStart });
      },
    }),
    [style, full, darkTheme, lightTheme, scheme, prefs.indicators, prefs.inlineChanges, prefs.wrap],
  );

  const peekAt = st.useStore((s) => s.peek?.at);
  const suggesting = st.useStore((s) => s.suggesting);
  const asking = st.useStore((s) => s.asking);
  const asks = st.useStore((s) => s.asks);
  const suggestingHere = suggesting && file && suggesting.path === file.name ? suggesting : null;
  // Always reject: the review's diff never changes; suggest.complete keeps the edited lines.
  const onEditComplete = useCallback((event: FileDiffEditCompleteEvent<Meta, undefined>) => {
    void suggest.complete(event as FileDiffEditCompleteEvent<unknown, undefined>);
    return "reject" as const;
  }, []);
  const threads = st.useStore((s) => (s.github?.status === "ready" ? s.github.threads : null));
  const checkNotes = st.useStore((s) => (s.github?.status === "ready" ? s.github.annotations : null));
  const outline = st.useStore((s) => (file ? s.outlines[file.name] : undefined));
  const sidebar = st.useStore((s) => s.sidebar);
  const outlineOpen = st.useStore((s) => s.outlineOpen);

  useEffect(() => {
    if (file) nav.loadOutline(file.name, file.prevName);
  }, [file]);

  const annotations = useMemo<DiffLineAnnotation<Meta>[]>(() => {
    if (!file) return [];
    // Replies render inside their thread, not on their own.
    const list: DiffLineAnnotation<Meta>[] = drafts
      .filter((d) => d.path === file.name && !d.replyTo && d.id !== suggestingHere?.draftId)
      .map((d) => ({ side: d.side, lineNumber: d.end, metadata: { id: d.id } }));
    if (suggestingHere)
      list.push({ side: "additions", lineNumber: suggestingHere.end, metadata: { suggesting: true } });
    const askPath = asking?.side === "deletions" ? (file.prevName ?? file.name) : file.name;
    if (asking && asking.path === askPath)
      list.push({ side: asking.side, lineNumber: asking.end, metadata: { asking: true } });
    // Earlier conversations with Claude, folded under their lines (the open one shows in full).
    for (const t of asks) {
      if (t.outdated) continue; // its lines are gone; it stays in the Claude panel
      const path = t.side === "deletions" ? (file.prevName ?? file.name) : file.name;
      if (t.path !== path) continue;
      const open = asking && asking.side === t.side && asking.start === t.start && asking.end === t.end;
      if (!open) list.push({ side: t.side, lineNumber: t.end, metadata: { ask: t.id } });
    }
    for (const t of threads ?? []) {
      if (t.path !== file.name) continue;
      // File-level and outdated threads sit above the first change.
      const placed = t.line !== null && !t.outdated && t.subject === "line";
      list.push({
        side: placed ? t.side : "additions",
        lineNumber: placed ? (t.line ?? 0) : 0,
        metadata: { thread: t.id },
      });
    }
    // What CI said about lines of this file (on the PR's head commit, so the new side).
    for (const a of checkNotes ?? [])
      if (a.path === file.name) list.push({ side: "additions", lineNumber: a.end, metadata: { ci: a.id } });
    if (peekAt) list.push({ side: peekAt.side, lineNumber: peekAt.line, metadata: { peek: true } });
    return list;
  }, [drafts, file, peekAt, threads, checkNotes, suggestingHere, asking, asks]);

  const selected = useMemo<SelectedLineRange | null>(() => {
    if (!cursor || suggestingHere) return null; // the editor owns the selection while suggesting
    const from = anchor ?? cursor;
    return { start: from.line, side: from.side, end: cursor.line, endSide: cursor.side };
  }, [cursor, anchor, suggestingHere]);

  useEffect(() => {
    if (!cursor || !file) return;
    // A drawn row gets the usual centre-or-nudge; CodeView only draws rows near the viewport,
    // so a far jump asks it to centre the line instead.
    if (findRow(cursor.side, cursor.line)) revealLine(cursor.side, cursor.line, 0);
    else
      codeView.current?.scrollTo({
        type: "line",
        id: file.name,
        lineNumber: cursor.line,
        side: cursor.side,
        align: "center",
        behavior: "instant",
      });
  }, [cursor, file]);

  const renderAnnotation = useCallback(
    (a: DiffLineAnnotation<Meta>) =>
      "asking" in a.metadata ? (
        <AskAnnotation />
      ) : "ask" in a.metadata ? (
        <AskChip id={a.metadata.ask} />
      ) : "suggesting" in a.metadata ? (
        <SuggestingBar />
      ) : "peek" in a.metadata ? (
        <PeekAnnotation />
      ) : "ci" in a.metadata ? (
        <CheckAnnotationRow id={a.metadata.ci} />
      ) : "thread" in a.metadata ? (
        <ThreadAnnotation id={a.metadata.thread} />
      ) : (
        <DraftAnnotation id={a.metadata.id} />
      ),
    [],
  );

  const items = useMemo<CodeViewDiffItem<Meta>[]>(
    () =>
      file
        ? [
            {
              id: file.name,
              type: "diff",
              version: ++nextDiffVersion,
              fileDiff: sinceDiff ?? file,
              // Since you viewed, the old side is your viewed copy, not the base: only new-side notes fit.
              annotations: sinceDiff ? annotations.filter((a) => a.side === "additions") : annotations,
              edit: !!suggestingHere && !suggestingHere.ending,
            },
          ]
        : [],
    [file, sinceDiff, annotations, suggestingHere],
  );

  if (!file) return null;
  const { add, del } = stats(sinceDiff ?? file); // the counts follow the view
  const dirs = dirname(file.name).split("/").filter(Boolean);
  // Which function or class the cursor is in, from the side it's on.
  const scope = cursor
    ? nav.enclosing(cursor.side === "additions" ? outline?.new : outline?.old, cursor.line).slice(-2)
    : [];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-page">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4 shadow-[0_1px_0_var(--line)]">
        {!sidebar ? (
          <IconButton label="Show file list" keys="Mod+\\" onClick={() => st.set({ sidebar: true })}>
            <SidebarExpand />
          </IconButton>
        ) : null}
        <nav aria-label="File path" className="flex min-w-0 items-center gap-1 overflow-hidden text-[13px]">
          {file.prevName ? (
            <span className="truncate text-ink-3" title={`Renamed from ${file.prevName}`}>
              {basename(file.prevName)} →
            </span>
          ) : null}
          {dirs.map((d, i) => (
            <span key={`${i}:${d}`} className="flex shrink items-center gap-1 truncate text-ink-3">
              <span className="truncate">{d}</span>
              <span className="text-line-strong">/</span>
            </span>
          ))}
          <span className="min-w-[4ch] truncate font-medium text-ink">{basename(file.name)}</span>
          {scope.map((sym) => (
            <span key={`${sym.line}:${sym.name}`} className="flex min-w-0 shrink items-center gap-1 text-ink-2">
              <NavArrowRight width={12} height={12} className="shrink-0 text-ink-3" />
              <span className="truncate font-mono text-[12px]">{sym.name}</span>
            </span>
          ))}
        </nav>
        <span className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-chip bg-inset px-1.5 font-mono text-[11.5px] tabular-nums shadow-[inset_0_0_0_1px_var(--line)]">
          <span className="text-green">+{add}</span>
          <span className="text-red">−{del}</span>
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {changedSince ? (
            <TextSegmented
              label="Which changes"
              value={sinceOn ? "since" : "all"}
              onChange={(v) => st.set({ sinceViewed: v === "since" ? file.name : null })}
              options={[
                { value: "all", label: "All changes" },
                { value: "since", label: "Since you viewed" },
              ]}
            />
          ) : null}
          <IconButton
            label={full ? "Fold unchanged lines" : "Show the whole file"}
            keys="f"
            onClick={() => void st.setFullFile(file.name, !full)}
            className={full ? "bg-hover-2 text-ink" : ""}
          >
            <Expand />
          </IconButton>
          <IconButton label="Comment on file" keys="C" onClick={st.startFileComment}>
            <ChatPlusIn />
          </IconButton>
          <Segmented
            label="Diff layout"
            value={style}
            options={STYLE_OPTIONS}
            onChange={(v) => v !== style && st.toggleStyle()}
          />
          <Tooltip label={viewed ? "Mark as not viewed" : "Mark as viewed"} keys="v">
            <Toggle
              pressed={viewed}
              onPressedChange={() => st.toggleViewed()}
              className="group/viewed flex h-7 items-center gap-1.5 rounded-control bg-surface pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2 shadow-btn transition-[background-color,color,transform,box-shadow] duration-100 active:scale-[0.97] data-pressed:bg-green-tint data-pressed:text-green data-pressed:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--green)_30%,transparent)] [@media(hover:hover)]:hover:text-ink [@media(hover:hover)]:data-pressed:hover:text-green"
            >
              <span
                aria-hidden
                className="flex size-3.5 items-center justify-center rounded-[4px] shadow-[inset_0_0_0_1.5px_var(--line-strong)] transition-[background-color,box-shadow] duration-100 group-data-pressed/viewed:bg-green group-data-pressed/viewed:text-page group-data-pressed/viewed:shadow-none"
              >
                {viewed ? <Check width={11} height={11} strokeWidth={2.5} /> : null}
              </span>
              Viewed
            </Toggle>
          </Tooltip>
        </div>
        {outlineOpen ? null : <OutlineToggle />}
      </header>
      <div className="min-h-0 flex-1">
        <RightClick resolve={lineMenu} className="h-full">
          <CodeView<Meta, undefined>
            ref={codeView}
            className="h-full overflow-auto"
            containerRef={(node) => node?.setAttribute("data-diff-scroll", "")}
            items={items}
            options={options}
            renderAnnotation={(annotation, _source, item) =>
              item.type === "diff" ? renderAnnotation(annotation as DiffLineAnnotation<Meta>) : null
            }
            selectedLines={selected ? { id: file.name, range: selected } : null}
            onItemEditComplete={(event) => onEditComplete(event as FileDiffEditCompleteEvent<Meta, undefined>)}
          />
        </RightClick>
      </div>
    </main>
  );
}
