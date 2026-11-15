import type { CodeViewFileItem, DiffTokenEventBaseProps, TokenEventBase } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, useStableCallback } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, SidebarExpand, Xmark } from "iconoir-react/regular";
import { useEffect, useMemo, useRef } from "react";
import { HIGHLIGHTER } from "./Code";
import { CODE_SCROLL, DIFF_CSS, linkKey, revealIn, tokenLink } from "./DiffPane";
import { FilePath } from "./FilePath";
import * as nav from "./nav";
import { OutlineToggle } from "./Outline";
import { PeekAnnotation } from "./Peek";
import { fileQuery, useOutline } from "./query";
import * as st from "./state";
import { useTheme } from "./theme";
import { IconButton, Kbd } from "./ui";

type Peek = { peek: true };
// CodeView only updates a controlled item when its version changes.
let nextFileVersion = 0;

/**
 * A file outside the review, opened from a definition or reference: read-only, with the same
 * navigation as the diff (⌘-click, gd, gr, the outline). ⌘[ or Esc goes back.
 */
export function FilePane() {
  const browse = st.useStore((s) => s.browse);
  const peekAt = st.useStore((s) => s.peek?.at);
  const sidebar = st.useStore((s) => s.sidebar);
  const outlineOpen = st.useStore((s) => s.outlineOpen);
  const outline = useOutline(browse?.path, undefined, false);
  const { darkThemeName, lightThemeName, resolvedColorScheme } = useTheme();
  const path = browse?.path;
  const line = browse?.line;
  const rev = st.useStore((s) => s.rev);
  // Outside the review, so not in the diff the version comes from: read it again each time it
  // opens (what was cached shows meanwhile), or an edit made since would never show.
  const text = useQuery({ ...fileQuery(rev, path ?? ""), enabled: !!path, staleTime: 0 });
  const contents = text.data?.new ?? null;

  // The file's length, for the line count shown with it.
  useEffect(() => {
    if (!path || contents === null) return;
    const lines = contents.split("\n").length;
    st.set((s) => (s.browse?.path === path ? { browse: { ...s.browse, lines } } : {}));
  }, [path, contents]);

  const ready = contents !== null;
  // CodeView draws only the rows near the viewport: a 30,000-line file opens as fast as a small one.
  const view = useRef<CodeViewHandle<Peek, undefined>>(null);
  const peekLine = peekAt?.line;
  const items = useMemo<CodeViewFileItem<Peek>[]>(
    () =>
      path && contents !== null
        ? [
            {
              id: path,
              type: "file",
              version: ++nextFileVersion,
              // The highlight cache is keyed by this: a changed file must not reuse the old colouring.
              file: { name: path, contents, cacheKey: `${path}:${st.hashOf(contents)}` },
              annotations: peekLine ? [{ lineNumber: peekLine, metadata: { peek: true } }] : [],
            },
          ]
        : [],
    [path, contents, peekLine],
  );
  useEffect(() => {
    if (ready && line && path) revealIn(view.current, path, line);
  }, [ready, line, path]);
  const selected = useMemo(() => (path && line ? { id: path, range: { start: line, end: line } } : null), [path, line]);
  const renderPeek = useStableCallback(() => <PeekAnnotation />);

  const wrap = st.useStore((s) => s.prefs.wrap);
  const options = useMemo(
    () => ({
      theme: { dark: darkThemeName, light: lightThemeName },
      themeType: resolvedColorScheme,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      preferredHighlighter: HIGHLIGHTER,
      lineHoverHighlight: "number" as const,
      unsafeCSS: DIFF_CSS,
      onTokenEnter: (t: TokenEventBase | DiffTokenEventBaseProps, e: PointerEvent) => {
        const b = st.get().browse;
        if (b)
          tokenLink.enter(t.tokenElement, e, { path: b.path, side: "additions", line: t.lineNumber }, t.lineCharStart);
      },
      onTokenLeave: (t: TokenEventBase | DiffTokenEventBaseProps) => tokenLink.leave(t.tokenElement),
      onTokenClick: async (t: TokenEventBase | DiffTokenEventBaseProps, e: MouseEvent) => {
        const b = st.get().browse;
        if (!b) return;
        st.set({ browse: { ...b, line: t.lineNumber } });
        if (!linkKey(e)) return;
        e.preventDefault();
        const at = { path: b.path, side: "additions" as const, line: t.lineNumber };
        if (!(await tokenLink.symbolAt(at, t.lineCharStart))) return;
        void nav.lookup("definition", { col: t.lineCharStart });
      },
    }),
    [darkThemeName, lightThemeName, resolvedColorScheme, wrap],
  );

  if (!browse) return null;
  // pnpm's store paths are unreadable; a dependency shows from its package name on.
  const dep = browse.path.lastIndexOf("node_modules/");
  const shown = dep === -1 ? browse.path : browse.path.slice(dep + "node_modules/".length);
  const scope = nav.enclosing(outline?.new, browse.line).slice(-2);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-page">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4 shadow-[0_1px_0_var(--line)]">
        {!sidebar ? (
          <IconButton label="Show file list" keys="Mod+\\" onClick={() => st.set({ sidebar: true })}>
            <SidebarExpand />
          </IconButton>
        ) : null}
        <IconButton label="Back" keys="Mod+[" onClick={nav.goBack}>
          <ArrowLeft />
        </IconButton>
        <FilePath path={shown} fullPath={browse.path} scope={scope} />
        <span className="shrink-0 rounded-chip bg-hover px-1.5 py-px text-[11.5px] text-ink-3">
          {dep === -1 ? "Not in this review" : "Dependency"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Kbd k="Esc" quiet />
          <IconButton label="Back to the review" keys="Esc" onClick={nav.goBack}>
            <Xmark />
          </IconButton>
        </div>
        {outlineOpen ? null : <OutlineToggle />}
      </header>
      <div className="min-h-0 flex-1">
        {items.length ? (
          <CodeView<Peek, undefined>
            key={browse.path}
            ref={view}
            className={CODE_SCROLL}
            containerRef={(node) => node?.setAttribute("data-diff-scroll", "")}
            items={items}
            options={options}
            selectedLines={selected}
            renderAnnotation={renderPeek}
          />
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">
            {text.error ? text.error.message : text.isPending ? "Reading…" : "This file isn't in the working tree."}
          </p>
        )}
      </div>
    </main>
  );
}
