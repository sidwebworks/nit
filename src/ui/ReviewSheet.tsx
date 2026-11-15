import { Scroll, Sheet } from "@silk-hq/components";
import { Copy, EditPencil, Lock, OpenNewWindow, Sparks, WarningTriangle, Xmark } from "iconoir-react/regular";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AskThread, Draft, ReviewEvent } from "../types";
import * as agent from "./agent";
import { api } from "./api";
import { splitLabel } from "./Comments";
import { copy } from "./Menu";
import { draftsAsMarkdown } from "./review";
import * as st from "./state";
import { Button, basename, dirname, IconButton, Kbd, TextSegmented, Tooltip } from "./ui";

const labelTone: Record<string, string> = {
  blocking: "bg-red-tint text-red",
  issue: "bg-red-tint text-red",
  question: "bg-accent-tint text-accent-ink",
  suggestion: "bg-green-tint text-green",
  praise: "bg-green-tint text-green",
};

const where = (d: Draft) =>
  d.replyTo ? "Reply" : d.start === 0 ? "File" : d.start === d.end ? `L${d.end}` : `L${d.start}–${d.end}`;

/** First line of a comment as plain text, for the list. */
const preview = (body: string) =>
  (body.split("\n").find((l) => l.trim()) ?? "")
    .replace(/`|\*\*|__|~~/g, "")
    .replace(/^\s*(#+|>|[-*+]( \[[ xX]\])?)\s+/, "")
    .trim();

/** The start of an answer across its lines, for a two-line preview. */
const gist = (body: string) =>
  body
    .split("\n")
    .map((l) => preview(l))
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);

function copyAll() {
  const { files } = st.get();
  const drafts = st.get().drafts.filter((d) => !d.proposal);
  copy(
    draftsAsMarkdown(
      drafts,
      files.map((f) => f.name),
    ),
    `${drafts.length} ${drafts.length === 1 ? "comment" : "comments"} as Markdown`,
  );
}

const VERDICTS: { value: ReviewEvent; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

/**
 * Every draft in the review, grouped by file: check your review before it leaves your machine.
 * A Silk sheet from the right (non-commercial licence: nit is a personal open-source tool).
 */
/** Hands the comments to Claude instead of (or before) posting them. */
function ApplyButton({ primary = false }: { primary?: boolean }) {
  const count = st.useStore(
    (s) => s.drafts.filter((d) => !d.replyTo && !d.proposal && (d.body.trim() || d.suggestion !== null)).length,
  );
  const running = st.useStore((s) => s.agent?.state === "running");
  return (
    <Tooltip label="Apply comments with AI" keys="Mod+Shift+a" side="top">
      <Button tone={primary ? "primary" : "secondary"} disabled={!count || running} onClick={() => void agent.apply()}>
        <Sparks width={14} height={14} /> {running ? "Applying…" : "Apply with AI"}
      </Button>
    </Tooltip>
  );
}

/** Claude reads the whole diff and proposes comments; nothing posts until you accept it. */
function CoReviewButton() {
  const busy = st.useStore((s) => s.agent?.state === "running" || s.job?.state === "running");
  const reviewing = st.useStore((s) => s.job?.kind === "review" && s.job.state === "running");
  return (
    <Tooltip label="AI reviews the diff and proposes comments for you to accept" side="top">
      <Button tone="secondary" disabled={busy} onClick={() => void agent.coreview()}>
        <Sparks width={14} height={14} /> {reviewing ? "Reviewing…" : "Co-review"}
      </Button>
    </Tooltip>
  );
}

export function ReviewSheet() {
  const open = st.useStore((s) => s.reviewOpen);
  const drafts = st.useStore((s) => s.drafts);
  const files = st.useStore((s) => s.files);
  const gh = st.useStore((s) => s.github);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [summary, setSummary] = useState("");
  const [posting, setPosting] = useState(false);
  const pr = gh?.status === "ready" ? gh : null;
  const behind = pr && (pr.local.dirty || pr.local.headSha !== pr.pr.headSha);
  // Claude's proposals don't post until accepted.
  const postable = drafts.filter((d) => !d.proposal && (d.body.trim() || d.suggestion !== null)).length;

  async function post() {
    if (!pr || posting || (!postable && !summary.trim() && event === "COMMENT")) return;
    setPosting(true);
    try {
      const r = await api.postReview(event, summary);
      await st.load();
      void st.loadGitHub(true);
      if (r.failed.length) {
        st.toast(
          `${r.failed.length} of ${r.failed.length + r.posted.length} comments didn't post; they're still here.`,
        );
      } else {
        st.set({ reviewOpen: false });
        setSummary("");
        setEvent("COMMENT");
        st.notify(
          r.asFileComments.length
            ? `Review posted · ${r.asFileComments.length} as file comments`
            : `Review posted on #${pr.pr.number}`,
          r.url ? { label: "Open", run: () => window.open(r.url ?? "", "_blank", "noopener") } : undefined,
        );
      }
    } catch (e) {
      st.fail(e instanceof Error ? e.message : "Couldn't post the review.");
    } finally {
      setPosting(false);
    }
  }

  // Your comments, and beside them your conversations with Claude: kept for you, never posted.
  const asks = st.useStore((s) => s.asks);
  const groups = useMemo(() => {
    const order = new Map(files.map((f, i) => [f.name, i]));
    const byFile = Map.groupBy(drafts, (d) => d.path);
    return [...byFile.entries()]
      .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
      .map(([path, list]) => ({ path, list: list.toSorted((a, b) => a.start - b.start) }));
  }, [drafts, files]);
  const questions = useMemo(() => {
    const order = new Map(files.map((f, i) => [f.name, i]));
    return asks.toSorted((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9) || a.start - b.start);
  }, [asks, files]);
  // Opened from the sidebar's questions button: start at them.
  const questionsRef = useRef<HTMLElement>(null);
  const at = st.useStore((s) => s.reviewAt);
  useEffect(() => {
    if (!open || at !== "questions") return;
    const t = setTimeout(() => {
      const el = questionsRef.current;
      // Scroll the list itself; scrollIntoView would also slide Silk's sheet sideways.
      let box = el?.parentElement;
      while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
      if (el && box) box.scrollTop = el.offsetTop - 8;
      st.set({ reviewAt: null });
    }, 50);
    return () => clearTimeout(t);
  }, [open, at]);

  const go = (d: Draft) => {
    st.set({ reviewOpen: false });
    st.focusDraft(d.id);
  };

  return (
    <Sheet.Root license="non-commercial" presented={open} onPresentedChange={(p) => st.set({ reviewOpen: p })}>
      <Sheet.Portal>
        <Sheet.View contentPlacement="right" className="z-50">
          <Sheet.Backdrop className="bg-[oklch(0_0_0/0.28)]" />
          <Sheet.Content className="box-border flex h-svh w-[460px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-l-window bg-surface shadow-overlay">
            <header className="flex h-14 shrink-0 items-center gap-3 px-4 shadow-[0_1px_0_var(--line)]">
              <div className="min-w-0 flex-1">
                <Sheet.Title className="text-[14px] font-medium text-ink">Review</Sheet.Title>
                <Sheet.Description className="truncate text-[12px] text-ink-3 tabular-nums">
                  {pr ? (
                    <a
                      href={pr.pr.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 hover:text-ink-2"
                    >
                      #{pr.pr.number} {pr.pr.title} <OpenNewWindow width={11} height={11} />
                    </a>
                  ) : (
                    <>
                      {drafts.length} {drafts.length === 1 ? "comment" : "comments"} in {groups.length}{" "}
                      {groups.length === 1 ? "file" : "files"}
                    </>
                  )}
                </Sheet.Description>
              </div>
              <Kbd k="Esc" quiet />
              <IconButton label="Close" keys="Esc" onClick={() => st.set({ reviewOpen: false })}>
                <Xmark />
              </IconButton>
            </header>

            {behind ? (
              <div className="flex gap-2 bg-orange-tint px-4 py-2.5 text-[12px] text-ink-2 shadow-[0_1px_0_var(--line)]">
                <WarningTriangle width={14} height={14} className="mt-px shrink-0 text-orange" />
                <span>
                  {pr?.local.dirty ? "You have uncommitted changes" : "Your branch isn't at the PR's latest commit"}.
                  Comments on lines GitHub can't find post as file comments that name the line.
                </span>
              </div>
            ) : null}
            <Scroll.Root className="min-h-0 flex-1">
              <Scroll.View className="h-full w-full">
                <Scroll.Content className="box-border w-full min-w-0 p-2">
                  {groups.length || questions.length ? null : (
                    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
                      <span className="text-ink-2">No comments yet</span>
                      <span className="text-[12px] text-ink-3">
                        Press <Kbd k="c" /> on a line to start one.
                      </span>
                    </div>
                  )}
                  {groups.map(({ path, list }) => (
                    <section key={path} className="mb-2">
                      <div className="flex h-8 items-baseline gap-1.5 px-2 pt-2">
                        <span className="shrink-0 text-[12.5px] font-medium text-ink">{basename(path)}</span>
                        <span className="min-w-0 truncate text-[12px] text-ink-3">
                          {dirname(path).replace(/\/$/, "")}
                        </span>
                        <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">{list.length}</span>
                      </div>
                      {list.map((d) => {
                        const { label, rest } = splitLabel(d.body);
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => go(d)}
                            className="flex w-full items-start gap-2.5 rounded-control px-2 py-2 text-left transition-[background-color] duration-100 [@media(hover:hover)]:hover:bg-hover"
                          >
                            <span className="mt-px w-12 shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
                              {where(d)}
                            </span>
                            {d.proposal ? (
                              <Tooltip label="Proposed by AI: accept it on the card to post it">
                                <Sparks width={13} height={13} className="mt-0.5 shrink-0 text-accent-ink" />
                              </Tooltip>
                            ) : null}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                {label ? (
                                  <span
                                    className={`shrink-0 rounded-chip px-1.5 py-px text-[11px] font-medium ${labelTone[label] ?? "bg-hover-2 text-ink-2"}`}
                                  >
                                    {label}
                                  </span>
                                ) : null}
                                <span className="truncate text-[13px] text-ink">
                                  {preview(rest) || (d.suggestion !== null ? "Suggested change" : "Empty comment")}
                                </span>
                              </span>
                              {d.suggestion !== null ? (
                                <span className="mt-1 flex items-center gap-1 text-[11.5px] text-green">
                                  <EditPencil width={12} height={12} /> Suggests a change
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {questions.length ? (
                    <section
                      ref={questionsRef}
                      className="not-first:mt-2 not-first:pt-2 not-first:shadow-[0_-1px_0_var(--line)]"
                    >
                      <div className="flex h-8 items-center gap-1.5 px-2 pt-1">
                        <Sparks width={13} height={13} className="text-accent-ink" />
                        <span className="text-[12.5px] font-medium text-ink">Your questions</span>
                        <span className="text-[12px] text-ink-3 tabular-nums">{questions.length}</span>
                        <span className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-3">
                          <Lock width={11} height={11} /> Only you see these
                        </span>
                      </div>
                      {questions.map((t) => (
                        <AskRow key={t.id} t={t} />
                      ))}
                    </section>
                  ) : null}
                </Scroll.Content>
              </Scroll.View>
            </Scroll.Root>

            {pr ? (
              // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ posts from anywhere in the footer
              <footer
                className="shrink-0 space-y-2.5 bg-inset px-4 pt-3 pb-3.5 shadow-[0_-1px_0_var(--line)]"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    void post();
                  }
                }}
              >
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Leave a summary (optional)"
                  aria-label="Review summary"
                  rows={2}
                  className="block w-full resize-none rounded-control bg-field px-3 py-2 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <TextSegmented label="Verdict" value={event} onChange={setEvent} options={VERDICTS} />
                  <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    <IconButton label="Copy as Markdown" onClick={copyAll} side="top">
                      <Copy />
                    </IconButton>
                    <CoReviewButton />
                    <ApplyButton />
                    <Button
                      tone="primary"
                      onClick={() => void post()}
                      disabled={posting || (!postable && !summary.trim() && event === "COMMENT")}
                    >
                      {posting ? "Posting…" : postable ? `Post ${postable}` : "Post"}{" "}
                      <span className="opacity-70">⌘↵</span>
                    </Button>
                  </span>
                </div>
              </footer>
            ) : (
              <footer className="flex h-14 shrink-0 items-center gap-3 bg-inset px-4 shadow-[0_-1px_0_var(--line)]">
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3"
                  title={gh?.status === "unavailable" ? gh.reason : ""}
                >
                  {gh?.status === "unavailable" ? gh.reason : "Looking for the pull request…"}
                </span>
                <Button tone="secondary" onClick={copyAll} disabled={!drafts.length}>
                  <Copy width={14} height={14} /> Copy as Markdown
                </Button>
                <CoReviewButton />
                <ApplyButton primary />
              </footer>
            )}
          </Sheet.Content>
        </Sheet.View>
      </Sheet.Portal>
    </Sheet.Root>
  );
}

/** One conversation with Claude: the last question, the start of the answer, and where it was asked. */
function AskRow({ t }: { t: AskThread }) {
  const last = t.turns.at(-1);
  return (
    <button
      type="button"
      onClick={() => {
        st.set({ reviewOpen: false });
        agent.reopen(t);
      }}
      className="block w-full rounded-control px-2 py-2 text-left transition-[background-color] duration-100 [@media(hover:hover)]:hover:bg-hover"
    >
      <span className="block truncate text-[13px] text-ink">{last?.question}</span>
      <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-ink-3">{gist(last?.answer ?? "")}</span>
      <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-3 tabular-nums">
        <span className="font-mono">
          {basename(t.path)}:{t.start === t.end ? t.start : `${t.start}–${t.end}`}
        </span>
        {t.turns.length > 1 ? <span>· {t.turns.length} questions</span> : null}
        {t.outdated ? <span className="text-orange">· lines changed since</span> : null}
      </span>
    </button>
  );
}
