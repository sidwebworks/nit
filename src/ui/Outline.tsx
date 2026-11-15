import { ArrowRight, Copy, List, SidebarCollapse, SidebarExpand } from "iconoir-react/regular";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Side, Symbol as Sym } from "../types";
import { changedLines, firstInRange } from "./lines";
import { copy, type MenuItem, RightClick } from "./Menu";
import * as nav from "./nav";
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

type Entry = Sym & { depth: number; status: "added" | "changed" | null; changedLine?: number };

const key = (s: Sym) => `${s.kind}:${s.name}`;

/** Old symbols whose span holds a removed line: they changed even if no line was added. */
function touchedOld(old: Sym[], removed: number[]) {
  const keys = new Set<string>();
  for (const s of old) if (firstInRange(removed, s.line, s.endLine) !== undefined) keys.add(key(s));
  return keys;
}

/**
 * Nesting by containment, plus what the diff did to each symbol: `added` if it didn't exist
 * before, `changed` if an added line falls in it or a removed line fell in its old version.
 */
function entries(symbols: Sym[], old: Sym[] | null, added: Set<number>, removed: Set<number>): Entry[] {
  const before = old ? new Set(old.map(key)) : null;
  const addedLines = [...added].sort((a, b) => a - b);
  const touched = old ? touchedOld(old, [...removed].sort((a, b) => a - b)) : new Set<string>();
  const stack: Sym[] = [];
  return symbols.map((s) => {
    while (stack.length && stack[stack.length - 1].endLine < s.line) stack.pop();
    const depth = stack.length;
    stack.push(s);
    const changedLine = firstInRange(addedLines, s.line, s.endLine);
    const status =
      before && !before.has(key(s)) ? "added" : changedLine !== undefined || touched.has(key(s)) ? "changed" : null;
    return { ...s, depth, status, changedLine };
  });
}

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

export function OutlinePanel() {
  const browse = st.useStore((s) => s.browse);
  // A file opened outside the review has symbols but no changes.
  const file = st.useStore((s) => (s.browse ? undefined : st.currentFile(s)));
  const path = browse?.path ?? file?.name;
  const outline = st.useStore((s) => (path ? s.outlines[path] : undefined));
  const reviewCursor = st.useStore((s) => s.cursor);
  const browseLine = browse?.line;
  const cursor = useMemo(
    () => (browseLine ? { side: "additions" as const, line: browseLine } : reviewCursor),
    [browseLine, reviewCursor],
  );
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [filter, setFilter] = useState("");
  const width = st.useStore((s) => s.widths.outline);

  useEffect(() => {
    if (file) nav.loadOutline(file.name, file.prevName);
  }, [file]);

  const view = useMemo(() => {
    if (!outline) return null;
    if (!file) return { all: entries(outline.new ?? [], null, new Set(), new Set()), removed: [], changedCount: 0 };
    const { added, removed: gone } = changedLines(file);
    const all = entries(outline.new ?? [], file.type === "new" ? [] : outline.old, added, gone);
    const present = new Set((outline.new ?? []).map(key));
    const removed = (outline.old ?? []).filter((s) => !present.has(key(s)));
    return { all, removed, changedCount: all.filter((e) => e.status).length };
  }, [file, outline]);

  const here = cursor?.side === "additions" ? nav.enclosing(outline?.new, cursor.line).at(-1) : undefined;
  const shown = useMemo(
    () => (view ? (onlyChanged ? view.all.filter((e) => e.status) : view.all) : []),
    [view, onlyChanged],
  );
  // Filtering flattens the tree and ranks by fzf; matched letters are painted, not wrapped.
  const q = filter.trim();
  const found = useMemo(() => (q ? fuzzy(shown, q, (e) => e.name) : null), [shown, q]);
  const rows = found ? found.map((r) => ({ ...r.item, depth: 0 })) : shown;
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paintMatches(
      "nit-outline",
      listRef.current,
      new Map(found?.map((r) => [`${r.item.line}:${r.item.name}`, r.positions])),
    );
  }, [found]);
  useEffect(() => () => void CSS.highlights?.delete("nit-outline"), []);

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

      <div className="shrink-0 px-2.5 pt-1.5 pb-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0])
              void nav.revealSymbol(rows[0], "additions", onlyChanged ? rows[0].changedLine : undefined);
            else if (e.key === "Escape" && filter) setFilter("");
            else if (e.key === "Escape") e.currentTarget.blur();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          placeholder="Filter symbols"
          aria-label="Filter symbols"
          spellCheck={false}
          className="h-7 w-full rounded-control bg-field px-2.5 text-[12.5px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]"
        />
      </div>
      <RightClick resolve={symbolMenu} className="flex min-h-0 flex-1 flex-col">
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {!outline ? <p className="px-2 py-2 text-[12px] text-ink-3">Reading symbols…</p> : null}
          {outline && !outline.new && !outline.old ? (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-ink-3">No outline for this file type yet.</p>
          ) : null}
          {rows.map((e) => (
            <SymbolRow
              key={`${e.line}:${e.name}`}
              entry={e}
              active={here === e || (here?.line === e.line && here.name === e.name)}
              side="additions"
              changedView={onlyChanged}
            />
          ))}
          {view && filter.trim() && !rows.length ? (
            <p className="px-2 py-2 text-[12px] text-ink-3">No symbol matches “{filter.trim()}”.</p>
          ) : null}
          {view && onlyChanged && !filter.trim() && !rows.length ? (
            <p className="px-2 py-2 text-[12px] text-ink-3">No symbols changed in this file.</p>
          ) : null}
          {view?.removed.length ? (
            <>
              <div className="px-2 pt-3 pb-1 text-[11.5px] font-medium text-ink-3">Removed</div>
              {view.removed.map((s) => (
                <SymbolRow
                  key={`old:${s.line}:${s.name}`}
                  entry={{ ...s, depth: 0, status: null }}
                  removed
                  side="deletions"
                />
              ))}
            </>
          ) : null}
        </div>
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
      onClick={() => void nav.revealSymbol(entry, side, changedView ? entry.changedLine : undefined)}
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
