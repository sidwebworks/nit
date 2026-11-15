import { Menu } from "@base-ui/react/menu";
import { ChatLines, Check, EyeClosed, GitBranch, Search, Sparks } from "iconoir-react/regular";
import { useMemo } from "react";
import type { Prefs } from "../types";
import * as agent from "./agent";
import { ChangedTree } from "./ChangedTree";
import { GuideList } from "./Guide";
import { stats } from "./lines";
import { PullRequestButton } from "./PullRequest";
import { SettingsButton } from "./Settings";
import * as st from "./state";
import { IconButton, Kbd, ProgressRing, Resizer } from "./ui";

const HIDE: { pref: keyof Prefs; label: string; category?: string }[] = [
  { pref: "hideGenerated", label: "Generated files", category: "generated" },
  { pref: "hideTests", label: "Tests", category: "test" },
  { pref: "hideDocs", label: "Docs", category: "docs" },
  { pref: "hideWhitespace", label: "Whitespace changes", category: "formatting" },
  { pref: "hideViewed", label: "Viewed files" },
];

/** Claude's reading order: asks for one, then switches between it and the tree. */
function GuideButton() {
  const has = st.useStore((s) => !!s.data?.guide);
  const on = st.useStore((s) => s.prefs.guided && !!s.data?.guide);
  const busy = st.useStore((s) => s.job?.state === "running" || s.agent?.state === "running");
  const ordering = st.useStore((s) => s.job?.state === "running" && s.job.kind === "guide");
  const label = has
    ? on
      ? "Show the files as a tree"
      : "Show the suggested reading order"
    : "Ask AI for a reading order";
  return (
    <button
      type="button"
      disabled={!has && busy}
      aria-pressed={has ? on : undefined}
      onClick={() => (has ? st.setPrefs({ guided: !on }) : void agent.guide())}
      title={label}
      aria-label={label}
      className={`flex h-5 items-center gap-1 rounded-[5px] px-1 transition-[background-color,color] duration-100 enabled:[@media(hover:hover)]:hover:bg-hover-2 enabled:[@media(hover:hover)]:hover:text-ink-2 disabled:opacity-50 ${on ? "bg-accent-tint text-accent-ink" : ""}`}
    >
      {ordering ? (
        <span className="size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
      ) : (
        <Sparks width={13} height={13} />
      )}
    </button>
  );
}

/**
 * Sets aside what isn't the change itself: lockfiles, generated code, snapshots (as
 * .gitattributes or convention says), tests, docs, and the files you've already viewed.
 */
function HideMenu({ hidden }: { hidden: number }) {
  const prefs = st.useStore((s) => s.prefs);
  const categories = st.useStore((s) => s.categories);
  const viewed = st.useStore((s) => s.viewed.size);
  const count = (c?: string) => (c ? Object.values(categories).filter((x) => x === c).length : viewed);
  return (
    <Menu.Root>
      <Menu.Trigger
        className={`flex h-5 items-center gap-1 rounded-[5px] px-1 tabular-nums transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink-2 data-popup-open:bg-hover-2 ${hidden ? "text-ink-2" : ""}`}
        aria-label={hidden ? `Hide files, ${hidden} hidden` : "Hide files"}
      >
        <EyeClosed width={13} height={13} />
        {hidden || null}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50 outline-none" sideOffset={4} align="start">
          <Menu.Popup className="min-w-[210px] origin-(--transform-origin) rounded-card bg-surface p-1 shadow-overlay outline-none transition-[opacity,scale] duration-100 ease-out-strong data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-ink-3">Hide</div>
            {HIDE.map((h) => (
              <Menu.CheckboxItem
                key={h.pref}
                checked={!!prefs[h.pref]}
                onCheckedChange={(on) => st.setPrefs({ [h.pref]: on })}
                closeOnClick={false}
                className="flex h-7 cursor-default items-center gap-2.5 rounded-[6px] px-2 text-[12.5px] text-ink-2 outline-none select-none data-highlighted:bg-hover-2 data-highlighted:text-ink"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-accent-ink">
                  <Menu.CheckboxItemIndicator>
                    <Check width={14} height={14} />
                  </Menu.CheckboxItemIndicator>
                </span>
                <span className="flex-1">{h.label}</span>
                <span className="text-[11.5px] text-ink-3 tabular-nums">{count(h.category)}</span>
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const count = (n: number) => n.toLocaleString();

export function FileList() {
  const agentRunning = st.useStore((s) => s.agent?.state === "running" || s.job?.state === "running");
  const jobKind = st.useStore((s) => (s.job?.state === "running" ? s.job.kind : null));
  const agentCount = st.useStore((s) => s.agent?.drafts.length ?? 0);
  const width = st.useStore((s) => s.widths.files);
  const files = st.useStore((s) => s.files);
  const viewed = st.useStore((s) => s.viewed);
  const changed = st.useStore((s) => s.changedSinceViewed.size);
  const drafts = st.useStore((s) => s.drafts);
  const asks = st.useStore((s) => s.asks.length);
  const branch = st.useStore((s) => s.data?.branch);
  const base = st.useStore((s) => s.data?.base);
  const done = useMemo(() => files.reduce((n, f) => n + (viewed.has(f.name) ? 1 : 0), 0), [files, viewed]);
  const categories = st.useStore((s) => s.categories);
  const guided = st.useStore((s) => s.prefs.guided && !!s.data?.guide);
  const hidden = st.useStore((s) => s.files.filter((f) => st.hiddenFile(f.name, s)).length);
  // The size of the change itself: generated files, tests and docs don't count.
  const code = useMemo(
    () =>
      files.reduce(
        (n, f) => {
          if (categories[f.name]) return n;
          const { add, del } = stats(f);
          return { add: n.add + add, del: n.del + del };
        },
        { add: 0, del: 0 },
      ),
    [files, categories],
  );

  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col bg-canvas shadow-[1px_0_0_var(--line)]" style={{ width }}>
      <Resizer
        edge="right"
        label="Resize the file tree"
        value={width}
        min={200}
        max={st.maxWidth("files")}
        onChange={(px) => st.setWidth("files", px)}
        onReset={() => st.setWidth("files", st.DEFAULT_WIDTHS.files)}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 px-3.5">
        <GitBranch className="shrink-0 text-ink-3" />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[13.5px] font-medium text-ink" title={branch}>
            {branch}
          </span>
          <span className="shrink-0 text-[12px] text-ink-3">into</span>
          <span className="truncate font-mono text-[11.5px] text-ink-2" title={base}>
            {base}
          </span>
        </div>
        <PullRequestButton />
      </header>

      {/* Where the review stands: viewed of total leads, the size of the change follows. */}
      <div className="flex h-7 shrink-0 items-center gap-2.5 pr-2 pl-3.5 text-[12px] text-ink-3">
        <span
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums"
          title={`${count(done)} of ${count(files.length)} files viewed`}
        >
          <ProgressRing value={files.length ? done / files.length : 0} />
          <span>
            <span className={done ? "text-ink" : "text-ink-2"}>{count(done)}</span> of {count(files.length)}
          </span>
        </span>
        <span
          className="min-w-0 truncate font-mono text-[11px] tabular-nums"
          title="Lines changed, not counting generated files, tests and docs"
        >
          <span className="text-green">+{count(code.add)}</span> <span className="text-red">−{count(code.del)}</span>
        </span>
        {changed ? (
          <span
            className="shrink-0 rounded-chip bg-orange-tint px-1.5 text-[11px] leading-[18px] text-orange tabular-nums"
            title={`${changed} files you marked viewed changed since`}
          >
            {changed} changed
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <HideMenu hidden={hidden} />
          <GuideButton />
        </span>
      </div>

      {guided ? <GuideList /> : <ChangedTree />}

      <footer className="flex h-11 shrink-0 items-center gap-1 px-2 shadow-[0_-1px_0_var(--line)]">
        {agentRunning ? (
          <button
            type="button"
            onClick={() => st.set({ agentOpen: true })}
            className="flex h-7 min-w-0 items-center gap-2 rounded-control px-2 text-[12.5px] text-ink-2 transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink"
          >
            <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
            <span className="truncate">
              {jobKind === "review"
                ? "AI is reviewing…"
                : jobKind === "ask"
                  ? "AI is answering…"
                  : jobKind === "guide"
                    ? "AI is ordering the files…"
                    : `AI is applying ${agentCount}…`}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => st.set({ reviewOpen: true })}
            disabled={!drafts.length}
            className="flex h-7 items-center gap-1.5 rounded-control px-2 text-[12.5px] text-ink-2 transition-[background-color,color] duration-100 enabled:[@media(hover:hover)]:hover:bg-hover-2 enabled:[@media(hover:hover)]:hover:text-ink disabled:text-ink-3"
          >
            <ChatLines className={drafts.length ? "text-orange" : ""} />
            <span className="tabular-nums">
              {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
            </span>
          </button>
        )}
        {asks ? (
          <button
            type="button"
            onClick={() => st.set({ reviewOpen: true, reviewAt: "questions" })}
            title="Your questions (only you see these)"
            className="flex h-7 items-center gap-1.5 rounded-control px-2 text-[12.5px] text-ink-2 tabular-nums transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink"
          >
            <Sparks width={14} height={14} className="text-accent-ink" />
            {asks}
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <SettingsButton />
          <Kbd k="Mod+k" quiet />
          <IconButton
            label="Search files and actions"
            keys="Mod+k"
            side="top"
            onClick={() => st.set({ palette: "all" })}
          >
            <Search />
          </IconButton>
        </span>
      </footer>
    </aside>
  );
}
