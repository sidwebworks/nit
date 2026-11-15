import type { TokenEventBase } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { ArrowLeft, SidebarExpand, Xmark } from "iconoir-react/regular";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { HIGHLIGHTER } from "./Code";
import { DIFF_CSS, linkKey, revealLine, tokenLink } from "./DiffPane";
import { FilePath } from "./FilePath";
import * as nav from "./nav";
import { OutlineToggle } from "./Outline";
import { PeekAnnotation } from "./Peek";
import * as st from "./state";
import { useTheme } from "./theme";
import { IconButton, Kbd } from "./ui";

const texts = new Map<string, Promise<string | null>>();
export const textOf = (path: string) => {
  let p = texts.get(path);
  if (!p) {
    p = api.file(path).then((c) => c.new);
    p.catch(() => texts.delete(path));
    texts.set(path, p);
  }
  return p;
};

/**
 * A file outside the review, opened from a definition or reference: read-only, with the same
 * navigation as the diff (⌘-click, gd, gr, the outline). ⌘[ or Esc goes back.
 */
export function FilePane() {
  const browse = st.useStore((s) => s.browse);
  const peekAt = st.useStore((s) => s.peek?.at);
  const sidebar = st.useStore((s) => s.sidebar);
  const outlineOpen = st.useStore((s) => s.outlineOpen);
  const outline = st.useStore((s) => (browse ? s.outlines[browse.path] : undefined));
  const { darkThemeName, lightThemeName, resolvedColorScheme } = useTheme();
  const [text, setText] = useState<{ path: string; contents: string | null; error?: string } | null>(null);
  const path = browse?.path;
  const line = browse?.line;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    nav.loadOutline(path, undefined, false);
    textOf(path).then(
      (contents) => {
        if (!alive) return;
        setText({ path, contents });
        if (contents !== null) {
          const lines = contents.split("\n").length;
          st.set((s) => (s.browse?.path === path ? { browse: { ...s.browse, lines } } : {}));
        }
      },
      (e: unknown) => alive && setText({ path, contents: null, error: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  const contents = text && text.path === path ? text.contents : null;
  const ready = contents !== null;
  useEffect(() => {
    if (ready && line) revealLine("additions", line);
  }, [ready, line]);

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
      onTokenEnter: (t: TokenEventBase, e: PointerEvent) => {
        const b = st.get().browse;
        if (b)
          tokenLink.enter(t.tokenElement, e, { path: b.path, side: "additions", line: t.lineNumber }, t.lineCharStart);
      },
      onTokenLeave: (t: TokenEventBase) => tokenLink.leave(t.tokenElement),
      onTokenClick: async (t: TokenEventBase, e: MouseEvent) => {
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
  const file = contents !== null ? { name: browse.path, contents, cacheKey: browse.path } : null;

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
      <div data-diff-scroll className="min-h-0 flex-1 overflow-auto">
        {file ? (
          <File<{ peek: true }>
            key={browse.path}
            file={file}
            options={options}
            selectedLines={{ start: browse.line, end: browse.line }}
            lineAnnotations={peekAt ? [{ lineNumber: peekAt.line, metadata: { peek: true } }] : []}
            renderAnnotation={() => <PeekAnnotation />}
          />
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">
            {text?.path === path && text?.error
              ? text.error
              : text?.path === path
                ? "This file isn't in the working tree."
                : "Reading…"}
          </p>
        )}
      </div>
    </main>
  );
}
