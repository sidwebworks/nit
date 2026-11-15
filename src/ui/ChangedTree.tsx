import type { FileDiffMetadata } from "@pierre/diffs";
import { type FileTreeRowDecoration, type GitStatus, preparePresortedFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { ChatPlusIn, CheckCircle, Copy, Link, Page } from "iconoir-react/regular";
import { useEffect, useMemo, useRef } from "react";
import { stats } from "./lines";
import { copy, type MenuItem, RightClick } from "./Menu";
import * as nav from "./nav";
import * as st from "./state";

const STATUS: Record<FileDiffMetadata["type"], GitStatus> = {
  new: "added",
  deleted: "deleted",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

const statusOf = (files: FileDiffMetadata[]) => files.map((f) => ({ path: f.name, status: STATUS[f.type] }));

/** Draft count, then +/−; a viewed file shows a check and greys its counts. Reads the live store. */
function decoration({ item }: { item: { path: string; kind: string } }): FileTreeRowDecoration | null {
  if (item.kind !== "file") return null;
  const s = st.get();
  const file = s.files.find((f) => f.name === item.path);
  if (!file) return null;
  const { add, del } = stats(file);
  const viewed = s.viewed.has(item.path);
  const drafts = s.drafts.filter((d) => d.path === item.path).length;
  // Viewed is the one thing to see at a glance: a solid check replaces the counts.
  if (viewed) return { icon: { name: "nit-viewed", width: 14, height: 14 }, title: `Viewed · +${add} −${del}` };
  // Viewed once, changed since: a hollow mark says "look again".
  if (s.changedSinceViewed.has(item.path))
    return {
      icon: { name: "nit-changed", width: 14, height: 14 },
      title: `Changed since you viewed it · +${add} −${del}`,
    };
  const parts = [
    ...(drafts ? [{ text: `${drafts}  `, color: "var(--orange)" }] : []),
    ...(add ? [{ text: `+${add}`, color: "var(--green)" }] : []),
    ...(add && del ? [{ text: " " }] : []),
    ...(del ? [{ text: `−${del}`, color: "var(--red)" }] : []),
  ];
  const title = [drafts ? `${drafts} draft comments` : "", `+${add} −${del}`].filter(Boolean).join(" · ");
  return { text: parts.map((p) => p.text).join(""), parts, title };
}

// The tree draws in its own shadow root; these map it onto nit's tokens and type.
const TREE_STYLE = {
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12.5px",
  "--trees-fg-override": "var(--ink-2)",
  "--trees-fg-muted-override": "var(--ink-3)",
  "--trees-bg-override": "var(--canvas)", // truncation markers paint this over the name
  "--trees-bg-muted-override": "var(--hover)",
  "--trees-accent-override": "var(--accent)",
  "--trees-border-color-override": "var(--line)",
  "--trees-selected-bg-override": "var(--hover-2)",
  "--trees-selected-fg-override": "var(--ink)",
  "--trees-selected-focused-border-color-override": "transparent",
  "--trees-focus-ring-color-override": "color-mix(in oklch, var(--accent) 70%, transparent)",
  "--trees-git-added-color-override": "var(--green)",
  "--trees-git-modified-color-override": "var(--ink-3)",
  "--trees-git-deleted-color-override": "var(--red)",
  "--trees-git-renamed-color-override": "var(--accent-ink)",
  "--trees-status-added-override": "var(--green)",
  "--trees-status-modified-override": "var(--ink-3)",
  "--trees-status-deleted-override": "var(--red)",
  "--trees-status-renamed-override": "var(--accent-ink)",
  "--trees-padding-inline-override": "6px",
  "--trees-scrollbar-thumb-override": "var(--line-strong)",
} as React.CSSProperties;

const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute"><symbol id="nit-viewed" viewBox="0 0 16 16">
<circle cx="8" cy="8" r="7" fill="var(--green)"/>
<path d="M4.9 8.3l2 2 4.2-4.5" fill="none" stroke="var(--page)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</symbol><symbol id="nit-changed" viewBox="0 0 16 16">
<circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--orange)" stroke-width="1.6"/>
<circle cx="8" cy="8" r="2.4" fill="var(--orange)"/>
</symbol></svg>`;

// Counts never give way to a long name. Flattened paths keep their useful end
// instead of squeezing every directory into a separate ellipsis.
const TREE_CSS = `
/* The filter box: quiet until focused, a magnifier before the text and the / key after it. */
[data-file-tree-search-container] { position: relative; padding-inline: 10px; margin-block: 2px 6px; }
[data-file-tree-search-input] {
  height: 28px; padding-inline: 28px 30px; border: 0; border-radius: 7px;
  font-family: var(--font-sans); font-size: 12.5px; color: var(--ink);
  background: var(--field); box-shadow: none;
  transition: box-shadow 120ms ease-out, background-color 120ms ease-out;
}
[data-file-tree-search-input]::placeholder { color: var(--ink-3); }
[data-file-tree-search-input]:hover { background: var(--hover); }
[data-file-tree-search-input]:focus { background: var(--field); box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-tint); }
[data-file-tree-search-container]::before {
  content: ""; position: absolute; left: 19px; top: 50%; width: 13px; height: 13px; translate: 0 -50%;
  background: var(--ink-3); pointer-events: none;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E") center / contain no-repeat;
}
[data-file-tree-search-container]::after {
  content: "/"; position: absolute; right: 16px; top: 50%; translate: 0 -50%;
  display: grid; place-items: center; min-width: 18px; height: 18px; border-radius: 5px;
  font: 500 11px/1 var(--font-sans); color: var(--ink-3); background: var(--hover);
  box-shadow: 0 0 0 1px var(--line); pointer-events: none;
}
[data-file-tree-search-container]:has(input:focus, input:not(:placeholder-shown))::after { display: none; }
/* With no match the tree falls back to every folder, closed: nit shows its note instead. */
:host(.nit-no-match) [data-file-tree-virtualized-scroll] { display: none; }
[data-item-section="content"] { flex: 1 1 0; min-width: 0; }
[data-item-flattened-subitems] { display: flex; min-width: 0; max-width: 100%; gap: 0; font-size: 0; }
[data-item-flattened-subitem] { min-width: 0; font-size: var(--trees-font-size); }
[data-item-flattened-subitem]:nth-last-of-type(n + 3) { display: none; }
[data-item-flattened-subitem]:nth-last-of-type(2) { display: flex; flex: 0 999999 auto; align-items: center; }
[data-item-flattened-subitem]:nth-last-of-type(2):not(:first-of-type)::before {
  content: "… / "; flex: none; white-space: pre;
}
[data-item-flattened-subitem]:nth-last-of-type(2)::after {
  content: " / "; flex: none; white-space: pre;
}
[data-item-flattened-subitem]:last-of-type { display: flex; flex: 0 1 auto; min-width: 4ch; }
[data-item-flattened-subitem] > [data-truncate-container] { min-width: 0; }
[data-item-section="decoration"] { flex: 0 0 auto; overflow: visible; }
[data-item-section="decoration"] > span {
  max-width: none; font-family: var(--font-mono); font-size: 11px; font-variant-numeric: tabular-nums;
}`;

/** Right-click on a row: a file's actions, or marking a whole folder viewed. */
function treeMenu(target: Element): MenuItem[] | null {
  const row = target.closest<HTMLElement>("[data-item-path]");
  const path = row?.dataset.itemPath?.replace(/\/$/, "");
  if (!row || !path) return null;
  const s = st.get();
  if (row.dataset.itemType !== "file") {
    const inside = s.files.map((f) => f.name).filter((n) => n.startsWith(`${path}/`));
    const all = inside.length > 0 && inside.every((n) => s.viewed.has(n));
    return [
      {
        label: all ? "Mark folder as not viewed" : `Mark ${inside.length} files as viewed`,
        icon: <CheckCircle />,
        run: () => st.setViewed(inside, !all),
      },
      { label: "Copy folder path", icon: <Copy />, run: () => copy(path, "the path") },
    ];
  }
  const index = s.files.findIndex((f) => f.name === path);
  if (index === -1) return null;
  const open = () => st.openFile(index);
  const gh = s.github;
  const link = gh?.status === "ready" ? `${gh.pr.url.replace(/\/pull\/\d+$/, "")}/blob/${gh.pr.headSha}/${path}` : null;
  const viewed = s.viewed.has(path);
  return [
    { label: "Open", icon: <Page />, run: open },
    {
      label: viewed ? "Mark as not viewed" : "Mark as viewed",
      icon: <CheckCircle />,
      run: () => st.setViewed([path], !viewed),
    },
    {
      label: "Comment on file",
      icon: <ChatPlusIn />,
      keys: "C",
      run: () => {
        open();
        st.startFileComment();
      },
    },
    null,
    { label: "Copy path", icon: <Copy />, run: () => copy(path, "the path") },
    ...(link ? [{ label: "Copy GitHub link", icon: <Link />, run: () => copy(link, "the GitHub link") }] : []),
  ];
}

/** Opens the file tree's filter box (/), while the tree is mounted. */
export let openTreeSearch: (() => void) | null = null;

/** The review's changed files as a tree (Pierre Trees). Selecting a file opens it. */
export function ChangedTree() {
  const files = st.useStore((s) => s.files);
  const current = st.useStore((s) => st.currentFile(s)?.name);
  const viewed = st.useStore((s) => s.viewed);
  const changedSinceViewed = st.useStore((s) => s.changedSinceViewed);
  const drafts = st.useStore((s) => s.drafts);

  // The files the list shows: the ones set aside (Hide generated, tests…) aren't in the tree.
  const shown = st.useStore((s) =>
    s.files
      .filter((f) => !st.hiddenFile(f.name, s))
      .map((f) => f.name)
      .join("\n"),
  );
  const paths = useMemo(() => (shown ? shown.split("\n") : []), [shown]);
  // The store already keeps files in the tree's own order (lines.inTreeOrder): hand the tree
  // that order prepared, so it skips shaping and sorting the paths again.
  const preparedInput = useMemo(() => preparePresortedFileTreeInput(paths), [paths]);
  const status = useMemo(() => {
    const inTree = new Set(paths);
    return statusOf(files.filter((f) => inTree.has(f.name)));
  }, [files, paths]);
  const { model } = useFileTree({
    preparedInput,
    search: true, // the tree's own filter box: type, ↑↓ through matches, Enter opens, Esc clears
    fileTreeSearchMode: "hide-non-matches",
    labels: { searchPlaceholder: "Filter files" },
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    stickyFolders: true, // a long tree keeps the folders above the top row in view
    itemHeight: 28,
    initialVisibleRowCount: Math.ceil(window.innerHeight / 28), // the first render fills the window
    gitStatus: status,
    renderRowDecoration: decoration,
    unsafeCSS: TREE_CSS,
    icons: { set: "complete", colored: true, spriteSheet: SPRITE },
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      const s = st.get();
      const index = path ? s.files.findIndex((f) => f.name === path) : -1;
      if (index === -1 || (index === s.current && !s.browse)) return;
      st.openFile(index);
      // Hand the keyboard back to the review: nit's single-letter keys would otherwise go to
      // the tree's type-to-find.
      // Picking from the filter box: close it now (closing hands focus to the tree), then let go.
      if (model.isSearchOpen()) model.closeSearch();
      requestAnimationFrame(() => {
        if (document.activeElement?.tagName === "FILE-TREE-CONTAINER") (document.activeElement as HTMLElement).blur();
      });
    },
  });

  const search = useFileTreeSearch(model);
  const q = search.value?.trim() ?? "";
  const names = useMemo(() => new Set(files.map((f) => f.name)), [files]);
  // Matches include the folders that hold them; a match means a file.
  const firstMatch = q ? search.matchingPaths.find((p) => names.has(p)) : undefined;
  const none = !!q && !firstMatch;
  // Enter opens the focused row: keep it on a matching file as the query changes.
  useEffect(() => {
    const focused = model.getFocusedPath();
    if (firstMatch && !(focused && names.has(focused) && search.matchingPaths.includes(focused)))
      model.focusPath(firstMatch);
  }, [model, firstMatch, names, search.matchingPaths]);
  useEffect(() => {
    openTreeSearch = () => model.openSearch();
    return () => {
      openTreeSearch = null;
    };
  }, [model]);
  const searchRepo = () => {
    st.set((s) => ({ search: { ...s.search, query: q } }));
    model.closeSearch();
    nav.openSearch();
  };

  // A new patch (a reload that changed files) replaces the tree's paths and statuses.
  const applied = useRef(preparedInput); // the tree was created with it: no reset on mount
  useEffect(() => {
    if (applied.current !== preparedInput) model.resetPaths({ preparedInput });
    applied.current = preparedInput;
    model.setGitStatus(status);
  }, [model, preparedInput, status]);

  // Drafts and viewed marks live in the decorations, which read the store when drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when either changes
  useEffect(() => {
    model.setComposition(model.getComposition());
  }, [model, viewed, changedSinceViewed, drafts, files]);

  // Keyboard and palette moves select the file in the tree and keep it in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: files changing can re-add the path
  useEffect(() => {
    if (!current) return;
    for (const p of model.getSelectedPaths()) if (p !== current) model.getItem(p)?.deselect();
    model.getItem(current)?.select();
    model.focusPath(current); // the tree's own focus, so a redraw can't re-select an old row
    model.scrollToPath(current, { focus: false, offset: "nearest" });
  }, [model, current, files]);

  return (
    <RightClick resolve={treeMenu} className="flex min-h-0 flex-1 flex-col">
      <FileTree
        model={model}
        className={`min-h-0 ${none ? "nit-no-match h-9 flex-none" : "flex-1"}`}
        style={TREE_STYLE}
      />
      {none ? (
        <p className="px-3.5 pt-0.5 text-[12px] leading-relaxed text-ink-3">
          No changed file matches “{q}”. {/* Keeps the tree's search box focused, so Esc still clears it. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={searchRepo}
            className="text-accent-ink underline-offset-2 hover:underline"
          >
            Search the repo
          </button>
        </p>
      ) : null}
    </RightClick>
  );
}
