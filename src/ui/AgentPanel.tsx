import { Scroll, Sheet } from "@silk-hq/components";
import { EditPencil, Eye, Page, Search, Undo, Xmark } from "iconoir-react/regular";
import type { ReactNode } from "react";
import type { AgentOutcome, AgentRun, Job } from "../types";
import * as agent from "./agent";
import * as st from "./state";
import { Button, basename, IconButton, Kbd } from "./ui";

const OUTCOME: Record<AgentOutcome["status"], { label: string; tone: string }> = {
  done: { label: "Applied", tone: "bg-green-tint text-green" },
  skipped: { label: "Skipped", tone: "bg-hover-2 text-ink-2" },
  question: { label: "Answered", tone: "bg-accent-tint text-accent-ink" },
};

/** Claude's note, with its `code` spans shown as code. */
export function Note({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed string
          <code key={i} className="rounded-[4px] bg-hover-2 px-1 font-mono text-[11.5px] text-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function OutcomeChip({ status }: { status: AgentOutcome["status"] }) {
  const o = OUTCOME[status];
  return <span className={`shrink-0 rounded-chip px-1.5 py-px text-[11px] font-medium ${o.tone}`}>{o.label}</span>;
}

const TOOL_ICON: Record<string, ReactNode> = {
  Read: <Page />,
  Edit: <EditPencil />,
  Write: <EditPencil />,
  Glob: <Search />,
  Grep: <Search />,
};

const seconds = (run: AgentRun) => Math.max(1, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));

/** One line under the title: what's happening, or what happened. */
function summary(run: AgentRun) {
  const n = run.drafts.length;
  if (run.state === "running") return `Applying ${n} ${n === 1 ? "comment" : "comments"}…`;
  if (run.state === "failed") return `Failed: ${run.error ?? "unknown error"}`;
  if (run.state === "undone") return "Undone";
  const done = run.outcomes.filter((o) => o.status === "done").length;
  const parts = [
    run.state === "stopped" ? "Stopped" : `Applied ${done} of ${n}`,
    `${run.files.length} ${run.files.length === 1 ? "file" : "files"}`,
    `${seconds(run)}s`,
    run.costUsd ? `$${run.costUsd.toFixed(2)}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="px-2 pt-2 pb-1 text-[12px] font-medium text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** What the last co-review proposed, what nit's checks dropped and why, and the guidelines it had. */
function CoReviewSummary({ job }: { job: Job }) {
  return (
    <Section title="Co-review">
      <p className="px-2 text-[12.5px] leading-snug text-ink-2">
        {job.state === "running"
          ? "Reading the diff…"
          : job.state === "failed"
            ? `Failed: ${job.error ?? "unknown error"}`
            : job.found
              ? `Proposed ${job.found} ${job.found === 1 ? "comment" : "comments"}, shown on the diff to accept or dismiss.`
              : "Nothing worth raising."}
        {job.summary ? ` ${job.summary}` : ""}
      </p>
      {job.dropped.length ? (
        <details className="mx-2 mt-1.5 text-[12px] text-ink-3">
          <summary className="cursor-pointer">{job.dropped.length} dropped by nit's checks</summary>
          <ul className="mt-1 space-y-1">
            {job.dropped.map((d) => (
              <li key={d.body} className="leading-snug">
                <span className="text-ink-2">{d.reason}:</span> {d.body}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mt-1.5 truncate px-2 text-[11.5px] text-ink-3" title={job.guidelines.inline.join("\n")}>
        Guidelines from the base branch: {job.guidelines.inline.length} in full
        {job.guidelines.indexed ? `, ${job.guidelines.indexed} more on request` : ""}
      </p>
    </Section>
  );
}

/**
 * Claude's pass over the drafts, from the right like the review sheet: live activity while it
 * works, then what it did with each comment, the files it changed, and undo.
 */
export function AgentPanel() {
  const open = st.useStore((s) => s.agentOpen);
  const run = st.useStore((s) => s.agent);
  const activity = st.useStore((s) => s.agentActivity);
  const drafts = st.useStore((s) => s.drafts);
  const job = st.useStore((s) => s.job);
  const asks = st.useStore((s) => s.asks);
  const running = run?.state === "running" || job?.state === "running";

  return (
    <Sheet.Root license="non-commercial" presented={open} onPresentedChange={(p) => st.set({ agentOpen: p })}>
      <Sheet.Portal>
        <Sheet.View contentPlacement="right" className="z-50">
          <Sheet.Backdrop className="bg-[oklch(0_0_0/0.28)]" />
          <Sheet.Content className="box-border flex h-svh w-[460px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-l-window bg-surface shadow-overlay">
            <header className="flex h-14 shrink-0 items-center gap-3 px-4 shadow-[0_1px_0_var(--line)]">
              {running ? (
                <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
              ) : null}
              <div className="min-w-0 flex-1">
                <Sheet.Title className="text-[14px] font-medium text-ink">AI</Sheet.Title>
                <Sheet.Description className="truncate text-[12px] text-ink-3 tabular-nums">
                  {run ? summary(run) : "Your questions, co-review and applied comments"}
                </Sheet.Description>
              </div>
              <Kbd k="Esc" quiet />
              <IconButton label="Close" keys="Esc" onClick={() => st.set({ agentOpen: false })}>
                <Xmark />
              </IconButton>
            </header>

            <Scroll.Root className="min-h-0 flex-1">
              <Scroll.View className="h-full w-full">
                <Scroll.Content className="box-border w-full min-w-0 p-2">
                  {job?.kind === "review" ? <CoReviewSummary job={job} /> : null}
                  {asks.length ? (
                    <Section title="Questions">
                      {asks.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => agent.reopen(t)}
                          className="flex w-full min-w-0 flex-col gap-0.5 rounded-control px-2 py-1.5 text-left transition-[background-color] duration-100 [@media(hover:hover)]:hover:bg-hover"
                        >
                          <span className="truncate text-[12.5px] text-ink">{t.turns.at(-1)?.question}</span>
                          <span className="truncate font-mono text-[11.5px] text-ink-3">
                            {t.path}:{t.start === t.end ? t.start : `${t.start}-${t.end}`}
                            {t.turns.length > 1 ? ` · ${t.turns.length} questions` : ""}
                            {t.outdated ? " · lines changed" : ""}
                          </span>
                        </button>
                      ))}
                    </Section>
                  ) : null}
                  {run?.outcomes.length ? (
                    <Section title="Comments">
                      {run.outcomes.map((o) => {
                        const d = drafts.find((x) => x.id === o.id);
                        return (
                          <button
                            key={o.id}
                            type="button"
                            disabled={!d}
                            onClick={() => {
                              st.set({ agentOpen: false, view: "review" });
                              if (d) st.focusDraft(d.id);
                            }}
                            className="flex w-full items-start gap-2.5 rounded-control px-2 py-2 text-left transition-[background-color] duration-100 enabled:[@media(hover:hover)]:hover:bg-hover"
                          >
                            <OutcomeChip status={o.status} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-[11.5px] text-ink-3">
                                {d ? `${basename(d.path)}${d.start ? `:${d.start}` : ""}` : "resolved"}
                              </span>
                              <span className="block text-[12.5px] leading-snug text-ink-2">
                                <Note text={o.note} />
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </Section>
                  ) : null}

                  {run?.files.length ? (
                    <Section title="Files changed">
                      {run.files.map((f) => (
                        <div key={f.path} className="flex h-7 items-center gap-2.5 px-2 text-[12.5px]">
                          <span
                            className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${
                              f.status === "A" ? "text-green" : f.status === "D" ? "text-red" : "text-ink-3"
                            }`}
                          >
                            {f.status}
                          </span>
                          <span className="min-w-0 truncate text-ink-2">{f.path}</span>
                        </div>
                      ))}
                    </Section>
                  ) : null}

                  {activity.length ? (
                    <Section title={running ? "Working" : "Activity"}>
                      {activity.map((a, i) =>
                        a.kind === "tool" ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
                          <div key={i} className="flex h-6 items-center gap-2 px-2 text-[12px]">
                            <span className="flex size-4 shrink-0 items-center justify-center text-ink-3 [&_svg]:size-[13px]">
                              {TOOL_ICON[a.tool] ?? <Page />}
                            </span>
                            <span className="shrink-0 text-ink-3">{a.tool}</span>
                            <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">{a.target}</span>
                          </div>
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
                          <p key={i} className="line-clamp-3 px-2 py-1 text-[12.5px] leading-snug text-ink-2">
                            {a.text}
                          </p>
                        ),
                      )}
                    </Section>
                  ) : null}

                  {!run && !asks.length && job?.kind !== "review" ? (
                    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
                      <span className="text-ink-2">Nothing applied yet</span>
                      <span className="text-[12px] text-ink-3">
                        Write comments, then Apply with AI from the review (<Kbd k="Mod+Shift+Enter" />
                        ).
                      </span>
                    </div>
                  ) : null}
                </Scroll.Content>
              </Scroll.View>
            </Scroll.Root>

            <footer className="flex h-14 shrink-0 items-center gap-2 bg-inset px-4 shadow-[0_-1px_0_var(--line)]">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">
                Reads and edits files in this checkout only. No commands.
              </span>
              {running ? (
                <Button tone="secondary" onClick={agent.stop}>
                  Stop
                </Button>
              ) : run?.files.length && run.state !== "undone" ? (
                <>
                  <Button tone="ghost" onClick={() => void agent.undo()}>
                    <Undo width={14} height={14} /> Undo
                  </Button>
                  <Button tone="primary" onClick={agent.showChanges}>
                    <Eye width={14} height={14} /> Show changes
                  </Button>
                </>
              ) : null}
            </footer>
          </Sheet.Content>
        </Sheet.View>
      </Sheet.Portal>
    </Sheet.Root>
  );
}
