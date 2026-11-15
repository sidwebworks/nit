import { Dialog } from "@base-ui/react/dialog";
import { CodeBracketsSquare, Page, Search } from "iconoir-react/regular";
import { type ReactNode, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actions, available } from "./actions";
import { stats } from "./lines";
import * as nav from "./nav";
import { useOutline } from "./query";
import * as st from "./state";
import { basename, dirname, fuzzy, Kbd, paintMatches } from "./ui";

type Item = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  meta?: ReactNode;
  keys?: string[];
  icon: ReactNode;
  run: () => void;
};

export function Palette() {
  const mode = st.useStore((s) => s.palette);
  if (!mode) return null;
  return <PaletteWindow mode={mode} />;
}

function PaletteWindow({ mode: opened }: { mode: "all" | "files" | "symbols" }) {
  const files = st.useStore((s) => s.files);
  const current = st.useStore((s) => st.currentFile(s));
  const outline = useOutline(current?.name, current?.prevName);
  const [query, setQuery] = useState(opened === "symbols" ? "@" : "");
  // Typing @ switches to the current file's symbols, as in editors.
  const mode = query.startsWith("@") ? "symbols" : opened === "symbols" ? "all" : opened;
  const deferred = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const result = useMemo(() => {
    const fileItems: Item[] = files.map((f, i) => {
      const { add, del } = stats(f);
      return {
        id: `file:${f.name}`,
        group: "Files",
        label: basename(f.name),
        hint: dirname(f.name).replace(/\/$/, ""),
        icon: <Page />,
        meta: (
          <span className="font-mono text-[11px] tabular-nums text-ink-3">
            {add ? <span className="text-green">+{add}</span> : null}{" "}
            {del ? <span className="text-red">−{del}</span> : null}
          </span>
        ),
        run: () => st.openFile(i),
      };
    });
    const actionItems: Item[] = actions
      .filter((a) => !a.hidden && a.id !== "files" && available(a))
      .map((a) => ({ id: a.id, group: a.group, label: a.label, keys: a.keys, icon: a.icon, run: a.run }));
    const symbolItems: Item[] = (outline?.new ?? []).map((sym) => ({
      id: `sym:${sym.line}:${sym.name}`,
      group: "Symbols",
      label: sym.name,
      hint: sym.kind,
      icon: <CodeBracketsSquare />,
      meta: <span className="font-mono text-[11px] text-ink-3">:{sym.line}</span>,
      run: () => void nav.revealSymbol(sym, "additions"),
    }));
    const needle = mode === "symbols" ? deferred.slice(1) : deferred;
    const pool =
      mode === "symbols"
        ? symbolItems
        : mode === "files"
          ? fileItems
          : deferred
            ? [...actionItems, ...fileItems]
            : actionItems;
    if (!needle) return { list: pool, marks: new Map<string, number[]>() };
    // Files match on dir/name; the hits split back onto the two spans for painting.
    const text = (it: Item) => (mode !== "symbols" && it.hint ? `${it.hint}/${it.label}` : it.label);
    const found = fuzzy(pool, needle, text, 60);
    const marks = new Map<string, number[]>();
    for (const { item, positions } of found) {
      const cut = mode !== "symbols" && item.hint ? item.hint.length + 1 : 0;
      marks.set(
        `${item.id}|l`,
        positions.filter((p) => p >= cut).map((p) => p - cut),
      );
      if (cut)
        marks.set(
          `${item.id}|h`,
          positions.filter((p) => p < cut - 1),
        );
    }
    return { list: found.map((r) => r.item), marks };
  }, [mode, files, deferred, outline]);
  const items = result.list;
  useLayoutEffect(() => paintMatches("nit-palette", listRef.current, result.marks), [result]);
  useEffect(() => () => void CSS.highlights?.delete("nit-palette"), []);

  const close = () => st.set({ palette: null });
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const move = (d: number) => {
    if (!items.length) return;
    const next = (active + d + items.length) % items.length;
    setActive(next);
    document.getElementById(`palette-${next}`)?.scrollIntoView({ block: "nearest" });
  };

  // Group headers only when not searching; search results are one ranked list.
  const grouped = !deferred || mode === "symbols";

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[oklch(0_0_0/0.28)]" />
        <Dialog.Popup
          aria-label={mode === "files" ? "Go to file" : "Command palette"}
          initialFocus={inputRef}
          className="fixed top-[13vh] left-1/2 z-50 flex max-h-[min(520px,70vh)] w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-window bg-surface shadow-overlay outline-none"
        >
          <div className="flex h-12 shrink-0 items-center gap-2.5 px-4 shadow-[0_1px_0_var(--line)]">
            <Search width={16} height={16} className="shrink-0 text-ink-3" />
            <input
              ref={inputRef}
              // Focus in the same frame the palette opens, so keys typed right after ⌘K land here
              // (the dialog's own initial focus can arrive a few hundred ms later).
              // biome-ignore lint/a11y/noAutofocus: the palette exists to type into
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={items[active] ? `palette-${active}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
                else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
                else if (e.key === "Enter") run(items[active]);
                else if (e.key === "Escape") close();
                else return;
                e.preventDefault();
              }}
              placeholder={
                mode === "symbols"
                  ? "Go to symbol in this file…"
                  : mode === "files"
                    ? "Search changed files…"
                    : "Search files and actions… (@ for symbols)"
              }
              className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-3"
            />
            <Kbd k="Esc" quiet />
          </div>

          <div
            id="palette-list"
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {items.map((it, i) => (
              <div key={it.id}>
                {grouped && (i === 0 || items[i - 1].group !== it.group) ? (
                  <div className={`px-2.5 pb-1 text-[11.5px] font-medium text-ink-3 ${i ? "pt-3" : "pt-1.5"}`}>
                    {it.group}
                  </div>
                ) : null}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keyboard (arrows + Enter) */}
                <div
                  id={`palette-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(it)}
                  className={`flex h-9 cursor-default items-center gap-2.5 rounded-control px-2.5 ${i === active ? "bg-hover-2" : ""}`}
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center ${i === active ? "text-ink" : "text-ink-3"}`}
                  >
                    {it.icon}
                  </span>
                  <span className={`shrink-0 truncate ${i === active ? "text-ink" : "text-ink-2"}`}>
                    <span data-hl={`${it.id}|l`}>{it.label}</span>
                  </span>
                  {it.hint ? (
                    <span className="min-w-0 truncate text-[12px] text-ink-3">
                      <span data-hl={`${it.id}|h`}>{it.hint}</span>
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {it.meta}
                    {it.keys?.map((k) => (
                      <Kbd key={k} k={k} />
                    ))}
                  </span>
                </div>
              </div>
            ))}
            {!items.length ? (
              <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
                <span className="text-ink-2">No results for “{query}”</span>
                <span className="text-[12px] text-ink-3">Try part of a file name or an action.</span>
              </div>
            ) : null}
          </div>

          <div className="flex h-9 shrink-0 items-center gap-4 bg-inset px-4 text-[11.5px] text-ink-3 shadow-[0_-1px_0_var(--line)]">
            <span className="flex items-center gap-1.5">
              <Kbd k="ArrowUp" quiet />
              <Kbd k="ArrowDown" quiet /> Move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd k="Enter" quiet /> Open
            </span>
            <span className="ml-auto">
              {mode === "symbols" ? "Symbols in this file" : mode === "files" ? "Changed files" : "Type @ for symbols"}
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
