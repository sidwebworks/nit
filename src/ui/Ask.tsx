import { ArrowUp, Sparks, Trash, Xmark } from "iconoir-react/regular";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CODEX_KEY_ERROR, CODEX_SIGN_IN_ERROR } from "../types";
import * as agent from "./agent";
import * as st from "./state";
import { Button, IconButton, Kbd } from "./ui";

const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

const STARTERS = [
  "What could go wrong here?",
  "Explain this change",
  "Who relies on this?",
  "Does this follow the project's guidelines?",
];

const TOOL_VERB: Record<string, string> = {
  Read: "Reading",
  Grep: "Searching for",
  Glob: "Looking for",
  grep: "Searching for",
  multi_grep: "Searching for",
  find_files: "Looking for",
  read_guideline: "Reading the guideline",
  file_diff: "Reading the diff of",
};

const linesOf = (a: { start: number; end: number }) =>
  a.start === a.end ? `line ${a.start}` : `lines ${a.start}–${a.end}`;

/** One question and its answer. */
function Turn({ question, answer, streaming = false }: { question: string; answer: string; streaming?: boolean }) {
  return (
    <div className="py-2 first:pt-0 [&+&]:shadow-[0_-1px_0_var(--line-soft)]">
      <p className="mb-1.5 text-[12.5px] text-ink-3">{question}</p>
      {answer ? (
        <div className="text-[13px]">
          <Suspense fallback={<p className="whitespace-pre-wrap">{answer}</p>}>
            <Markdown source={answer} streaming={streaming} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ask Claude about the selected lines, right under them: the answer streams in, grounded in
 * the code it reads and the project's guidelines. The conversation is kept for the review, so
 * coming back to these lines shows it again, and a follow-up continues it. "Comment with this"
 * turns the latest answer into your draft.
 */
export function AskAnnotation() {
  const at = st.useStore((s) => s.asking);
  const job = st.useStore((s) => s.job);
  const activity = st.useStore((s) => s.agentActivity);
  // A conversation reopened from the list (maybe outdated), else the current one on these lines.
  const thread = st.useStore((s) =>
    s.asking?.thread ? s.asks.find((t) => t.id === s.asking?.thread) : s.asking ? st.threadAt(s.asking) : undefined,
  );
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const who = st.useStore(st.reviewerName);

  const here =
    job?.kind === "ask" &&
    at &&
    job.at?.path === at.path &&
    job.at.side === at.side &&
    job.at.start === at.start &&
    job.at.end === at.end
      ? job
      : null;
  const running = here?.state === "running";
  const lastTool = [...activity].reverse().find((a) => a.kind === "tool");
  // Once saved, a finished answer is the thread's last turn; don't show it twice.
  const saved = thread?.turns.at(-1);
  const live =
    here && !(here.state === "done" && saved?.question === here.question && saved.answer === here.answer.trim())
      ? here
      : null;
  const latest = live?.state === "done" ? live.answer : saved?.answer;

  // Pierre mounts annotations a frame or two late; keep trying until focus lands.
  useEffect(() => {
    let tries = 0;
    let frame = 0;
    const focus = () => {
      input.current?.focus({ preventScroll: true });
      if (document.activeElement !== input.current && tries++ < 20) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!at) return null;
  const where = linesOf(at);
  const send = (q: string) => {
    if (!q.trim() || running) return;
    void agent.ask(q);
    setText("");
  };
  const close = () => {
    if (running) agent.stop();
    st.set({ asking: null });
  };
  const talked = !!thread?.turns.length || !!live;

  return (
    <div className="px-3 py-1.5 font-sans">
      <section
        aria-label={`Ask ${who} about ${where}`}
        className="max-w-[780px] overflow-hidden rounded-card bg-surface shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_45%,transparent),0_2px_8px_oklch(0_0_0/0.08)]"
      >
        <header className="flex h-9 items-center gap-2 px-3 text-[12px]">
          <Sparks width={13} height={13} className="shrink-0 text-accent-ink" />
          <span className="shrink-0 font-medium whitespace-nowrap text-ink">Ask {who}</span>
          <span className="min-w-0 truncate whitespace-nowrap text-ink-3">{where}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {thread && !running ? (
              <IconButton
                label="Delete this conversation"
                onClick={() => {
                  st.deleteAsk(thread.id);
                  st.set({ asking: null });
                }}
              >
                <Trash />
              </IconButton>
            ) : null}
            <Kbd k="Esc" quiet />
            <IconButton label="Close" keys="Esc" onClick={close}>
              <Xmark />
            </IconButton>
          </span>
        </header>

        {talked ? (
          <div className="max-h-[60vh] overflow-y-auto px-3.5 pb-3">
            {thread?.outdated ? (
              <p className="mb-2 rounded-control bg-orange-tint px-2.5 py-1.5 text-[12px] text-ink-2">
                These lines have changed since. A follow-up starts a new conversation about them as they are now.
              </p>
            ) : null}
            {thread?.turns.map((t) => (
              <Turn key={t.at} question={t.question} answer={t.answer} />
            ))}
            {live ? <Turn question={live.question ?? ""} answer={live.answer} streaming={running} /> : null}
            {running ? (
              // What Claude is doing right now, under the answer it's writing.
              <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
                <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
                <span className="truncate">
                  {lastTool?.kind === "tool"
                    ? `${TOOL_VERB[lastTool.tool] ?? lastTool.tool} ${lastTool.target}`.trim()
                    : "Thinking"}
                  …
                </span>
              </p>
            ) : null}
            {live?.state === "failed" ? (
              <p className="mt-1 text-[12.5px] text-red">
                {live.error ?? `${who} couldn't answer.`}
                {live.error === CODEX_SIGN_IN_ERROR || live.error === CODEX_KEY_ERROR ? (
                  <span className="block text-ink-3">
                    Run <code className="font-mono">codex login</code> in a terminal, or add an OpenAI key in{" "}
                    <button
                      type="button"
                      className="text-accent-ink [@media(hover:hover)]:hover:underline"
                      onClick={() => st.set({ settingsOpen: true, settingsSection: "reviewer" })}
                    >
                      Settings → Reviewer
                    </button>
                    .
                  </span>
                ) : null}
              </p>
            ) : null}
            {!running && latest ? (
              <div className="mt-2.5 flex items-center gap-1.5">
                <Button tone="secondary" className="h-6 px-2" onClick={() => agent.commentFromAnswer(latest)}>
                  Comment with this
                </Button>
                {live?.guidelines.inline.length ? (
                  <span className="ml-auto truncate text-[11.5px] text-ink-3" title={live.guidelines.inline.join("\n")}>
                    Used {live.guidelines.inline.length} project{" "}
                    {live.guidelines.inline.length === 1 ? "guideline" : "guidelines"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {STARTERS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="h-6 rounded-chip bg-hover px-2 text-[12px] text-ink-2 transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 bg-inset px-3 py-2 shadow-[0_-1px_0_var(--line)]">
          <textarea
            ref={input}
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(text);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
            placeholder={talked ? "Ask a follow-up…" : `Ask about ${where}…`}
            aria-label={`Question for ${who}`}
            className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-[13px] leading-6 text-ink outline-none placeholder:text-ink-3 [field-sizing:content]"
          />
          {running ? (
            <Button tone="ghost" className="h-6 px-2" onClick={agent.stop}>
              Stop
            </Button>
          ) : (
            <IconButton label="Ask" keys="Enter" onClick={() => send(text)} disabled={!text.trim()}>
              <ArrowUp />
            </IconButton>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Where you talked with Claude, folded to one quiet line under the lines: the last question and
 * how many. Opening it shows the whole conversation again.
 */
export function AskChip({ id }: { id: string }) {
  const t = st.useStore((s) => s.asks.find((x) => x.id === id));
  const who = st.useStore(st.reviewerName);
  if (!t) return null;
  const last = t.turns.at(-1);
  return (
    <div className="px-3 py-1 font-sans">
      <button
        type="button"
        onClick={() => st.set({ asking: { path: t.path, side: t.side, start: t.start, end: t.end }, peek: null })}
        className="flex h-7 max-w-[780px] items-center gap-2 rounded-control px-2 text-left text-[12px] text-ink-3 shadow-[0_0_0_1px_var(--line)] transition-[background-color,color] duration-100 [@media(hover:hover)]:hover:bg-hover [@media(hover:hover)]:hover:text-ink-2"
      >
        <Sparks width={12} height={12} className="shrink-0 text-accent-ink" />
        <span className="shrink-0 font-medium text-ink-2">{who}</span>
        <span className="min-w-0 truncate">{last?.question}</span>
        {t.turns.length > 1 ? <span className="shrink-0 tabular-nums">+{t.turns.length - 1}</span> : null}
      </button>
    </div>
  );
}
