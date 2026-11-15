import { canUseWASM, getFiletypeFromFileName, getSharedHighlighter, type SupportedLanguages } from "@pierre/diffs";
import { useEffect, useId, useState } from "react";
import { useTheme } from "./theme";

type Themes = { dark: string; light: string };

/**
 * Pierre's Highlights engine (WebAssembly lexers, synchronous) for every code view. Shiki JS
 * blocked the main thread 70–270ms per file switch; Highlights brought that to zero. One
 * engine per page: Pierre refuses to mix them. Highlights needs WebAssembly with SIMD; where a
 * browser lacks it (or blocks it), Shiki JS takes over.
 */
export const HIGHLIGHTER = canUseWASM() ? ("highlights" as const) : ("shiki-js" as const);
const cache = new Map<string, Promise<string | null>>();

export const langFor = (path: string) => getFiletypeFromFileName(path) ?? "";

/** Highlights with the same themes as the diff; unknown languages fall back to plain text. */
function highlight(source: string, lang: string, themes: Themes) {
  const key = `${themes.dark}\u0000${themes.light}\u0000${lang}\u0000${source}`;
  let p = cache.get(key);
  if (!p) {
    p = getSharedHighlighter({
      themes: [themes.dark, themes.light],
      langs: [lang as SupportedLanguages],
      preferredHighlighter: HIGHLIGHTER,
    })
      .then((h) => h.codeToHtml(source, { lang, themes, defaultColor: false }))
      .catch((e: unknown) => {
        console.warn(`nit: could not highlight ${lang}`, e);
        return null;
      });
    cache.set(key, p);
  }
  return p;
}

/** A highlighted code block. With `startLine`, lines are numbered from it. */
export function CodeBlock({
  source,
  lang,
  startLine,
  mark,
}: {
  source: string;
  lang: string;
  startLine?: number;
  /** A line number (counted from startLine) to highlight. */
  mark?: number;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const { darkThemeName: dark, lightThemeName: light } = useTheme();
  useEffect(() => {
    let alive = true;
    if (lang) highlight(source, lang, { dark, light }).then((h) => alive && setHtml(h));
    else setHtml(null);
    return () => {
      alive = false;
    };
  }, [source, lang, dark, light]);
  const numbered = startLine !== undefined;
  const style = numbered ? ({ counterReset: `line ${startLine - 1}` } as React.CSSProperties) : undefined;
  const cls = numbered ? "code-numbered" : undefined;
  // nth-child can't take a variable, so the marked line gets a rule scoped to this block.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const nth = mark !== undefined ? mark - (startLine ?? 1) + 1 : 0;
  const markRule =
    nth > 0 ? (
      <style>{`[data-code="${id}"] .line:nth-child(${nth}){background:var(--accent-tint);box-shadow:inset 2px 0 0 var(--accent)}`}</style>
    ) : null;
  // Shiki escapes the source, so its HTML is safe to insert.
  if (html)
    return (
      <>
        {markRule}
        <div
          className={cls}
          style={style}
          data-code={id}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output; the source is escaped
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </>
    );
  return (
    <>
      {markRule}
      <div className={cls} style={style} data-code={id}>
        <pre>
          <code>
            {source.split("\n").map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed block
              <span key={i} className="line">
                {l}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </>
  );
}
