import { Toast } from "@base-ui/react/toast";
import { EditProvider } from "@pierre/diffs/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { IconoirProvider } from "iconoir-react";
import { Check, GitCompare, WarningCircle } from "iconoir-react/regular";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "./AgentPanel";
import { handleKey, handleSuggestKey } from "./actions";
import * as agent from "./agent";
import { ChangesPane } from "./ChangesPane";
import { DiffPane } from "./DiffPane";
import { FileList } from "./FileList";
import { FilePane } from "./FilePane";
import logo from "./icon.svg";
import { useFindMarks } from "./marks";
import * as nav from "./nav";
import { OutlinePanel } from "./Outline";
import { Palette } from "./Palette";
import { PullRequestSheet } from "./PullRequest";
import { HighlightPool } from "./pool";
import { queryClient } from "./query";
import { ReviewSheet } from "./ReviewSheet";
import { SearchPane } from "./Search";
import { SettingsDialog } from "./Settings";
import { SignInDialog } from "./SignIn";
import * as st from "./state";
import { createEditor } from "./suggest";
import { theme } from "./theme";
import { toasts } from "./toasts";
import { EmptyState, Kbd, TooltipProvider } from "./ui";

const ICONS = { width: 15, height: 15, strokeWidth: 1.6 };

// ?debug exposes the store for poking at state from the console.
if (new URLSearchParams(location.search).has("debug"))
  Object.assign(window, { nit: st, nitNav: nav, nitThemes: theme });

/** Base UI toasts (stacking, swipe to dismiss, timers pause on hover) in nit's look. */
function Toasts() {
  const { toasts: list } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed bottom-4 left-1/2 z-40 w-[min(420px,calc(100vw-32px))] -translate-x-1/2">
        {list.map((t) => (
          <Toast.Root
            key={t.id}
            toast={t}
            className="absolute bottom-0 left-0 flex w-full items-center gap-2.5 rounded-card bg-surface py-2 pr-2 pl-3 text-[13px] text-ink shadow-overlay [transform:translateY(calc(var(--toast-index)*-6px))_scale(calc(1-var(--toast-index)*0.04))] transition-[transform,opacity] duration-200 ease-out-strong data-ending-style:opacity-0 data-limited:opacity-0 data-starting-style:[transform:translateY(8px)] data-starting-style:opacity-0"
          >
            {(t.data as { error?: boolean } | undefined)?.error ? (
              <WarningCircle className="shrink-0 self-start mt-px text-red" />
            ) : (
              <Check className="shrink-0 text-green" />
            )}
            <Toast.Title
              className={`min-w-0 flex-1 ${(t.data as { error?: boolean } | undefined)?.error ? "line-clamp-3" : "truncate"}`}
            />
            {t.actionProps ? (
              <Toast.Action className="flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 font-medium text-ink-2 transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink" />
            ) : null}
            {(t.data as { undo?: boolean } | undefined)?.undo ? <Kbd k="Mod+z" /> : null}
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

/**
 * The logo while the review loads, the same as index.html shows before the script runs. Its
 * animations are timed from page load, so taking over from the static one doesn't restart them.
 */
function Loading() {
  const [since] = useState(() => performance.now());
  return (
    <div className="loading">
      <img src={logo} alt="Loading" style={{ animationDelay: `${300 - since}ms, ${540 - since}ms` }} />
    </div>
  );
}

function App() {
  const hasData = st.useStore((s) => s.data !== null);
  const base = st.useStore((s) => s.data?.base);
  const error = st.useStore((s) => s.error);
  const count = st.useStore((s) => s.files.length);
  const sidebar = st.useStore((s) => s.sidebar);
  const outlineOpen = st.useStore((s) => s.outlineOpen);
  const browsing = st.useStore((s) => s.browse !== null);
  const view = st.useStore((s) => s.view);
  const searching = st.useStore((s) => s.searchOpen);
  useFindMarks();

  useEffect(() => {
    // The URL says where you were: a reload or a shared link opens there.
    st.load().then(nav.applyUrl).then(st.restoreBackups);
    void st.loadGitHub();
    const closeAgent = agent.connect();
    // Threads refresh every minute while the tab is visible (and when you come back to it).
    const poll = setInterval(() => document.visibilityState === "visible" && st.loadGitHub(), 60_000);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keydown", handleSuggestKey, true);
    // Coming back to the tab picks up edits made in the editor or by an agent.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Not while a suggestion is typed into the diff: a reload would swap the file under the editor.
      if (st.get().editing === null && !st.get().suggesting) void st.load();
      void st.loadGitHub();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keydown", handleSuggestKey, true);
      document.removeEventListener("visibilitychange", onVisible);
      closeAgent();
    };
  }, []);

  if (error && !hasData)
    return (
      <EmptyState
        icon={<WarningCircle />}
        title="Couldn't load the review"
        body="Check that nit is still running in your terminal, then reload this tab."
      />
    );
  if (!hasData) return <Loading />;
  if (!count)
    return (
      <EmptyState
        icon={<GitCompare />}
        title={`No changes against ${base}`}
        body="Commit, stage or edit something, then come back to this tab."
      />
    );

  return (
    <div className="flex h-full">
      {sidebar ? <FileList /> : null}
      {searching ? <SearchPane /> : browsing ? <FilePane /> : view === "agent" ? <ChangesPane /> : <DiffPane />}
      {outlineOpen && !searching ? <OutlinePanel /> : null}
      <Palette />
      <AgentPanel />
      <PullRequestSheet />
      <ReviewSheet />
      <SignInDialog />
      <SettingsDialog />
    </div>
  );
}

// The settings screen's code size, for Pierre's shadow roots (style.css reads --code-size).
const codeSize = () => document.documentElement.style.setProperty("--code-size", `${st.get().prefs.fontSize}px`);
codeSize();
st.subscribeToStore(codeSize);

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <IconoirProvider iconProps={ICONS}>
      <TooltipProvider>
        <Toast.Provider toastManager={toasts} limit={3}>
          <HighlightPool>
            <EditProvider createEditor={createEditor}>
              <App />
            </EditProvider>
          </HighlightPool>
          <Toasts />
        </Toast.Provider>
      </TooltipProvider>
    </IconoirProvider>
  </QueryClientProvider>,
);
