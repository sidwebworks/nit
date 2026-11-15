import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowLeft, Undo } from "iconoir-react/regular";
import { useEffect, useMemo, useState } from "react";
import * as agent from "./agent";
import { api } from "./api";
import { HIGHLIGHTER } from "./Code";
import { DIFF_CSS } from "./DiffPane";
import { stats } from "./lines";
import * as st from "./state";
import { useTheme } from "./theme";
import { Button, basename, dirname, IconButton, Kbd } from "./ui";

/** Only what Claude's last pass changed: the diff between the snapshots before and after it. */
export function ChangesPane() {
  const run = st.useStore((s) => s.agent);
  const style = st.useStore((s) => s.style);
  const { darkThemeName, lightThemeName, resolvedColorScheme } = useTheme();
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch whenever the pass changes
  useEffect(() => {
    let alive = true;
    api.agentChanges().then(
      (p) => alive && setPatch(p),
      (e: unknown) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [run?.id, run?.after]);

  const files = useMemo<FileDiffMetadata[]>(
    () => (patch ? parsePatchFiles(patch, { cacheKeyPrefix: `agent-${run?.id}` }).flatMap((p) => p.files) : []),
    [patch, run?.id],
  );
  const options = useMemo(
    () => ({
      theme: { dark: darkThemeName, light: lightThemeName },
      themeType: resolvedColorScheme,
      diffStyle: style,
      preferredHighlighter: HIGHLIGHTER,
      diffIndicators: "bars" as const,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      disableFileHeader: true,
      unsafeCSS: DIFF_CSS,
    }),
    [darkThemeName, lightThemeName, resolvedColorScheme, style],
  );
  const back = () => st.set({ view: "review" });

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-page">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4 shadow-[0_1px_0_var(--line)]">
        <IconButton label="Back to the review" keys="Esc" onClick={back}>
          <ArrowLeft />
        </IconButton>
        <span className="text-[13px] font-medium text-ink">AI changes</span>
        <span className="text-[12px] text-ink-3 tabular-nums">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {run?.state !== "undone" && files.length ? (
            <Button tone="ghost" onClick={() => void agent.undo()}>
              <Undo width={14} height={14} /> Undo
            </Button>
          ) : null}
          <Kbd k="Esc" quiet />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {error ? <p className="text-[12.5px] text-ink-3">{error}</p> : null}
        {patch !== null && !files.length && !error ? (
          <p className="text-[12.5px] text-ink-3">The last AI pass didn't change any files.</p>
        ) : null}
        {files.map((f) => {
          const { add, del } = stats(f);
          return (
            <section key={f.name} className="mb-4 overflow-hidden rounded-card shadow-card">
              <button
                type="button"
                onClick={() => {
                  const i = st.get().files.findIndex((x) => x.name === f.name);
                  back();
                  if (i !== -1) st.openFile(i);
                }}
                className="flex h-9 w-full items-center gap-2 bg-surface px-3 text-left text-[12.5px] shadow-[0_1px_0_var(--line)] [@media(hover:hover)]:hover:bg-hover"
              >
                <span className="font-medium text-ink">{basename(f.name)}</span>
                <span className="min-w-0 truncate text-ink-3">{dirname(f.name).replace(/\/$/, "")}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
                  <span className="text-green">+{add}</span> <span className="text-red">−{del}</span>
                </span>
              </button>
              <FileDiff fileDiff={f} options={options} />
            </section>
          );
        })}
      </div>
    </main>
  );
}
