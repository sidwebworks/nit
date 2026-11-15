import { ArrowRight, Copy, List, Search, SidebarCollapse, SidebarExpand } from "iconoir-react/regular";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ListRange, Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Side } from "../types";
import { changedLines } from "./lines";
import { copy, type MenuItem, RightClick } from "./Menu";
import * as nav from "./nav";
import { buildOutline, type Entry, jumpTarget } from "./outline-model";
import { useOutline } from "./query";
import * as st from "./state";
import { fuzzy, IconButton, paintMatches, Resizer, TextSegmented } from "./ui";

/** One letter per kind, coloured quietly so the names stay the focus. */
const KIND: Record<string, { letter: string; tone: string }> = {
  function: { letter: "ƒ", tone: "text-[oklch(0.72_0.12_300)]" },
  method: { letter: "m", tone: "text-[oklch(0.72_0.12_300)]" },
  class: { letter: "C", tone: "text-orange" },
  interface: { letter: "I", tone: "text-accent-ink" },
  type: { letter: "T", tone: "text-accent-ink" },
  module: { letter: "M", tone: "text-ink-2" },
  constant: { letter: "c", tone: "text-green" },
  macro: { letter: "#", tone: "text-ink-2" },
  enum: { letter: "E", tone: "text-orange" },
  variable: { letter: "v", tone: "text-green" },
  field: { letter: "f", tone: "text-ink-2" },
  suite: { letter: "D", tone: "text-accent-ink" },
  test: { letter: "t", tone: "text-green" },
};
const kindOf = (k: string) => KIND[k] ?? { letter: k.slice(0, 1), tone: "text-ink-3" };

/**
 * Hides or shows the outline (O). It sits in the outline's header while open and at the right
 * of the code header while closed, mirroring the file list's toggle on the left.
 */
export function OutlineToggle() {
  const open = st.useStore((s) => s.outlineOpen);
  return (
    <IconButton
      label={open ? "Hide outline" : "Show outline"}
      keys="O"
      onClick={() => st.set((s) => ({ outlineOpen: !s.outlineOpen }))}
    >
      {open ? <SidebarCollapse className="-scale-x-100" /> : <SidebarExpand className="-scale-x-100" />}
    </IconButton>
  );
}

/** Right-click on a symbol: go to it, find its references, copy its name. */
function symbolMenu(target: Element): MenuItem[] | null {
  const row = target.closest<HTMLElement>("[data-symbol]");
  const name = row?.dataset.symbol;
  if (!row || !name) return null;
  const go = () => row.click();
  return [
    { label: "Go to", icon: <ArrowRight />, run: go },
    {
      label: (
        <>
          Find references to <code className="font-mono text-[12px] text-ink">{name}</code>
        </>
      ),
      icon: <List />,
      keys: "g r",
      run: () => {
        go();
        void nav.lookup("references", { name });
      },
    },
    null,
    { label: "Copy name", icon: <Copy />, run: () => copy(name, "the name") },
  ];
}

type Item = { entry: Entry; side: Side; removed?: boolean } | { heading: string };
const ListPad = () => <div className="h-1.5" />;

export function OutlinePanel() {
  const browse = st.useStore((s) => s.browse);
  // A file opened outside the review has symbols but no changes.
  const file = st.useStore((s) => (s.browse ? undefined : st.currentFile(s)));
  const path = browse?.path ?? file?.name;
  // A file opened outside the review has no diff to match, so no old side.
  const outline = useOutline(path, file?.prevName, !browse);
  const reviewCursor = st.useStore((s) => s.cursor);
  const browseLine = browse?.line;
  const cursor = useMemo(
    () => (browseLine ? { side: "additions" as const, line: browseLine } : reviewCursor),
    [browseLine, reviewCursor],
  );
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [filter, setFilter] = useState("");
  const width = st.useStore((s) => s.widths.outline);

  const view = useMemo(() => {
    if (!outline) return null;
    if (!file) return buildOutline(outline.new ?? [], null, new Set(), new Set());
    const { added, removed: gone } = changedLines(file);
    return buildOutline(outline.new ?? [], file.type === "new" ? [] : outline.old, added, gone);
  }, [file, outline]);

  const here = cursor?.side === "additions" ? nav.enclosing(outline?.new, cursor.line).at(-1) : undefined;
  const shown = useMemo(
    () => (view ? (onlyChanged ? view.all.filter((e) => e.status) : view.all) : []),
    [view, onlyChanged],
  );
  // Filtering flattens the tree and ranks by fzf; matched letters are painted, not wrapped.
  const q = filter.trim();
  const found = useMemo(() => (q ? fuzzy(shown, q, (e) => e.name) : null), [shown, q]);
  const rows = useMemo(() => (found ? found.map((r) => ({ ...r.item, depth: 0 })) : shown), [found, shown]);
  // One virtualized list: a file can have thousands of symbols, and only the visible rows are drawn.
  const items = useMemo<Item[]>(() => {
    const removed = view?.removed ?? [];
    return [
      ...rows.map((entry) => ({ entry, side: "additions" as const })),
      ...(removed.length ? [{ heading: "Removed" }] : []),
      ...removed.map((s) => ({ entry: { ...s, depth: 0, status: null }, side: "deletions" as const, removed: true })),
    ];
  }, [rows, view]);
  const scroller = useRef<HTMLElement | null>(null);
  const list = useRef<VirtuosoHandle>(null);
  const visible = useRef<ListRange>({ startIndex: 0, endIndex: 0 });
  // Matched letters are painted with CSS highlights; rows mount as they scroll in, so repaint then too.
  const marks = useMemo(() => new Map(found?.map((r) => [`${r.item.line}:${r.item.name}`, r.positions])), [found]);
  const paint = useCallback(() => paintMatches("nit-outline", scroller.current, marks), [marks]);
  useEffect(() => paint(), [paint]);
  useEffect(() => () => void CSS.highlights?.delete("nit-outline"), []);
  // Follow the cursor: the symbol it's in stays in view as you move through the code.
  const hereIndex = here ? rows.findIndex((e) => e === here || (e.line === here.line && e.name === here.name)) : -1;
  useEffect(() => {
    if (hereIndex < 0) return;
    // A frame later: when the outline has just arrived, the list takes its new rows first.
    const id = requestAnimationFrame(() => {
      const { startIndex, endIndex } = visible.current;
      if (hereIndex < startIndex || hereIndex > endIndex)
        list.current?.scrollToIndex({ index: hereIndex, align: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [hereIndex]);

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col bg-canvas shadow-[-1px_0_0_var(--line)]"
      style={{ width }}
      aria-label="Outline"
    >
      <Resizer
        edge="left"
        label="Resize the outline"
        value={width}
        min={200}
        max={st.maxWidth("outline")}
        onChange={(px) => st.setWidth("outline", px)}
        onReset={() => st.setWidth("outline", st.DEFAULT_WIDTHS.outline)}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 px-3.5">
        <span className="text-[13px] font-medium text-ink">Outline</span>
        {view ? <span className="text-[12px] text-ink-3 tabular-nums">{view.all.length}</span> : null}
        <span className="ml-auto">
          <OutlineToggle />
        </span>
      </header>
      <div className="flex h-7 shrink-0 items-center gap-1 px-2.5">
        <TextSegmented
          label="Which symbols"
          value={onlyChanged ? "changed" : "all"}
          onChange={(v) => setOnlyChanged(v === "changed")}
          options={[
            { value: "all", label: "All" },
            {
              value: "changed",
              label: (
                <>Changed{view ? <span className="ml-1 text-ink-3 tabular-nums">{view.changedCount}</span> : null}</>
              ),
            },
          ]}
        />
      </div>

      <div className="relative shrink-0 px-2.5 pt-1.5 pb-1">
        <Search
          width={13}
          height={13}
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-[19px] mt-[2px] -translate-y-1/2 text-ink-3"
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0]) {
              const target = jumpTarget(rows[0], "additions", onlyChanged);
              void nav.revealSymbol(rows[0], target.side, target.line);
            } else if (e.key === "Escape" && filter) setFilter("");
            else if (e.key === "Escape") e.currentTarget.blur();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          placeholder="Filter symbols"
          aria-label="Filter symbols"
          spellCheck={false}
          className="h-7 w-full rounded-[7px] bg-field pr-2.5 pl-7 text-[12.5px] text-ink outline-none transition-[background-color,box-shadow] duration-100 ease-out placeholder:text-ink-3 [@media(hover:hover)]:hover:bg-hover focus:bg-field focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]"
        />
      </div>
      <RightClick resolve={symbolMenu} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-1.5 empty:hidden">
          {!outline ? <p className="px-2 py-2 text-[12px] text-ink-3">Reading symbols…</p> : null}
          {outline && !outline.new && !outline.old ? (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-ink-3">No outline for this file type yet.</p>
          ) : null}
          {view && filter.trim() && !rows.length ? (
            <p className="px-2 py-2 text-[12px] text-ink-3">No symbol matches “{filter.trim()}”.</p>
          ) : null}
          {view && onlyChanged && !filter.trim() && !rows.length ? (
            <p className="px-2 py-2 text-[12px] text-ink-3">No symbols changed in this file.</p>
          ) : null}
        </div>
        {items.length ? (
          <Virtuoso
            // A list per file, mounted with its rows: it opens on the symbol the cursor is in.
            key={path}
            initialTopMostItemIndex={hereIndex >= 0 ? { index: hereIndex, align: "center" } : 0}
            ref={list}
            className="min-h-0 flex-1"
            scrollerRef={(el) => {
              scroller.current = el instanceof HTMLElement ? el : null;
            }}
            data={items}
            computeItemKey={(_, item) =>
              "heading" in item ? `h:${item.heading}` : `${item.side}:${item.entry.line}:${item.entry.name}`
            }
            increaseViewportBy={280}
            rangeChanged={(r) => {
              visible.current = r;
            }}
            itemsRendered={paint}
            components={{ Header: ListPad, Footer: ListPad }}
            itemContent={(_, item) =>
              "heading" in item ? (
                <div className="px-3.5 pt-3 pb-1 text-[11.5px] font-medium text-ink-3">{item.heading}</div>
              ) : (
                <div className="px-1.5">
                  <SymbolRow
                    entry={item.entry}
                    active={
                      !item.removed &&
                      (here === item.entry || (here?.line === item.entry.line && here.name === item.entry.name))
                    }
                    removed={item.removed}
                    side={item.side}
                    changedView={!item.removed && onlyChanged}
                  />
                </div>
              )
            }
          />
        ) : null}
      </RightClick>
    </aside>
  );
}

function SymbolRow({
  entry,
  active = false,
  removed = false,
  side,
  changedView = false,
}: {
  entry: Entry;
  active?: boolean;
  removed?: boolean;
  side: Side;
  changedView?: boolean;
}) {
  const k = kindOf(entry.kind);
  return (
    <button
      type="button"
      onClick={() => {
        const target = jumpTarget(entry, side, changedView);
        void nav.revealSymbol(entry, target.side, target.line);
      }}
      data-symbol={entry.name}
      title={`${entry.kind} ${entry.name}, lines ${entry.line}–${entry.endLine}`}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-control pr-2 text-left transition-[background-color] duration-100 [@media(hover:hover)]:hover:bg-hover ${
        active ? "bg-hover-2" : ""
      }`}
      style={{ paddingLeft: 8 + Math.min(entry.depth, 6) * 12 }}
    >
      <span
        className={`w-3 shrink-0 text-center font-mono text-[11.5px] font-semibold ${removed ? "text-red" : k.tone}`}
      >
        {k.letter}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] ${removed ? "text-ink-3 line-through decoration-red/60" : active ? "text-ink" : "text-ink-2"}`}
      >
        <span data-hl={`${entry.line}:${entry.name}`}>{entry.name}</span>
      </span>
      {entry.status ? (
        <span
          className={`size-1.5 shrink-0 rounded-full ${entry.status === "added" ? "bg-green" : "bg-orange"}`}
          title={entry.status === "added" ? "Added in this diff" : "Changed in this diff"}
        />
      ) : null}
    </button>
  );
}
