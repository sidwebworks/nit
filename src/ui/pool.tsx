import { preloadHighlighter, type SupportedLanguages } from "@pierre/diffs";
import { useWorkerPool, WorkerPoolContextProvider, type WorkerPoolOptions } from "@pierre/diffs/react";
import { type ReactNode, useEffect, useMemo } from "react";
import { HIGHLIGHTER, langFor } from "./Code";
import * as st from "./state";
import { useTheme } from "./theme";

/**
 * Highlighting for every diff and file view. Pierre's recommended setup: Highlights on the
 * main thread for anything up to 100k characters (about 2ms), a worker for bigger files so a
 * 300 KB file paints plain text at once instead of blocking ~60ms. Results are cached by the
 * diff's cacheKey, so going back to a file is instant.
 */
const POOL: WorkerPoolOptions = {
  workerFactory: () => new Worker("/worker-portable.js"),
  poolSize: 2,
  // Highlights beats a worker round trip on anything this size; Shiki stays in the workers.
  ...(HIGHLIGHTER === "highlights" ? { mainThreadMaxCharacters: 100_000 } : {}),
};

/** The pool owns theme and token options; this keeps it on the chosen theme. */
function ThemeSync() {
  const pool = useWorkerPool();
  const { darkThemeName: dark, lightThemeName: light } = useTheme();
  useEffect(() => {
    void pool?.setRenderOptions({ theme: { dark, light } });
  }, [pool, dark, light]);
  // The review's languages load up front, so a file highlights on its first paint instead of
  // showing plain text while its language loads.
  const files = st.useStore((s) => s.files);
  const langs = useMemo(
    () => [...new Set(files.map((f) => langFor(f.name)).filter(Boolean))].sort().join(","),
    [files],
  );
  useEffect(() => {
    if (!langs) return;
    void preloadHighlighter({
      themes: [dark, light],
      langs: langs.split(",") as SupportedLanguages[],
      preferredHighlighter: HIGHLIGHTER,
    }).catch(() => {}); // a language it can't load just stays plain, as before
  }, [langs, dark, light]);
  return null;
}

export function HighlightPool({ children }: { children: ReactNode }) {
  const { darkThemeName: dark, lightThemeName: light } = useTheme();
  return (
    <WorkerPoolContextProvider
      poolOptions={POOL}
      highlighterOptions={{
        theme: { dark, light },
        preferredHighlighter: HIGHLIGHTER,
        lineDiffType: "word-alt",
        // ⌘-click and link hover need per-token elements.
        useTokenTransformer: true,
      }}
    >
      <ThemeSync />
      {children}
    </WorkerPoolContextProvider>
  );
}
