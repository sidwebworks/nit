import {
  type AgentEvent,
  type AgentRun,
  type AskThread,
  CODEX_KEY_ERROR,
  CODEX_SIGN_IN_ERROR,
  type Job,
  SIGN_IN_ERROR,
} from "../types";

const openReviewerSettings = () => st.set({ settingsOpen: true, settingsSection: "reviewer" });

import { api } from "./api";
import * as nav from "./nav";
import { needSignIn } from "./SignIn";
import * as st from "./state";

/**
 * The page's side of an agent pass: start, follow its live stream, and when it ends, reload the
 * review (the files changed) and say what it did.
 */

const MAX_ACTIVITY = 300;

function onRun(run: AgentRun) {
  const prev = st.get().agent;
  const fresh = prev?.id !== run.id;
  st.set((s) => ({ agent: run, agentActivity: fresh ? [] : s.agentActivity }));
  if (prev?.id === run.id && prev.state === "running" && run.state !== "running") void finished(run);
}

async function finished(run: AgentRun) {
  await st.load(); // the agent's edits are in the review's diff now
  if (run.error === SIGN_IN_ERROR) return needSignIn(() => apply(run.drafts));
  if (run.state === "failed") return st.fail(`Claude couldn't finish: ${run.error ?? "unknown error"}`);
  if (run.state === "stopped") return st.toast("Stopped. What Claude changed so far is kept; undo puts it back.");
  const done = run.outcomes.filter((o) => o.status === "done").length;
  const files = run.files.length;
  st.notify(
    `Claude applied ${done} of ${run.drafts.length} comments · ${files} ${files === 1 ? "file" : "files"} changed`,
    files ? { label: "Show changes", run: showChanges } : undefined,
  );
}

function onJob(job: Job) {
  const prev = st.get().job;
  const fresh = prev?.id !== job.id;
  st.set((s) => ({ job, agentActivity: fresh ? [] : s.agentActivity }));
  if (prev?.id === job.id && prev.state === "running" && job.state !== "running") void jobFinished(job);
}

async function jobFinished(job: Job) {
  if (job.error === SIGN_IN_ERROR)
    return needSignIn(
      job.kind === "review"
        ? coreview
        : job.kind === "guide"
          ? guide
          : // The same question about the same lines, wherever you are by then.
            () => {
              if (!job.at) return;
              st.set({ asking: job.at, peek: null });
              void ask(job.question ?? "", job.at);
            },
    );
  // An open ask box shows its own error.
  if (job.state === "failed")
    return job.kind === "ask" && st.get().asking
      ? undefined
      : job.error === CODEX_SIGN_IN_ERROR || job.error === CODEX_KEY_ERROR
        ? st.notify(`${job.error} Run \`codex login\`, or add an OpenAI key.`, {
            label: "Settings",
            run: openReviewerSettings,
          })
        : st.fail(`${job.reviewer === "codex" ? "Codex" : "Claude"} couldn't finish: ${job.error ?? "unknown error"}`);
  // A finished answer is saved with its lines' conversation: fetch those to show it there.
  if (job.kind === "ask" && job.state === "done")
    return void api.asks().then(
      (asks) => st.set({ asks }),
      () => {},
    );
  if (job.kind === "guide" && job.state === "done") {
    st.setPrefs({ guided: true });
    return void st.load(); // the guide comes with the review
  }
  if (job.state === "stopped" || job.kind !== "review") return;
  await st.load(); // the proposals are drafts now
  const dropped = job.dropped.length ? ` · ${job.dropped.length} dropped by checks` : "";
  const who = job.reviewer === "codex" ? "Codex" : "Claude";
  if (!job.found) return st.toast(`${who} found nothing worth raising${dropped}`);
  st.notify(`${who} proposed ${job.found} ${job.found === 1 ? "comment" : "comments"}${dropped}`, {
    label: "Review",
    run: () => {
      const first = st.orderedDrafts().find((d) => d.proposal);
      if (first) st.focusDraft(first.id);
    },
  });
}

/** Claude arranges the files into chapters, in the order to read them. */
export async function guide() {
  try {
    const { job } = await api.guide();
    st.set({ job, agentActivity: [] });
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't start the guide.");
  }
}

/** Claude reviews the whole diff; what survives nit's checks arrives as proposed comments. */
export async function coreview() {
  try {
    const { job } = await api.coreview();
    st.set({ job, agentActivity: [], reviewOpen: false });
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't start the co-review.");
  }
}

/**
 * Reopens a conversation from earlier in the review, at its lines: on the old side for removed
 * lines (found by the file's old name, in case it was renamed).
 */
export function reopen(t: AskThread) {
  const index = st.get().files.findIndex((f) => (t.side === "deletions" ? (f.prevName ?? f.name) : f.name) === t.path);
  if (index === -1) return st.fail(`${t.path} isn't in this review any more.`);
  st.set({ agentOpen: false });
  void nav.goTo(index, t.side, t.end);
  st.set({ asking: { path: t.path, side: t.side, start: t.start, end: t.end, thread: t.id }, peek: null });
}

/** Opens the ask box on the selected lines (or the cursor's line). */
export function startAsk() {
  const file = st.currentFile();
  const sel = st.selection();
  if (!file || !sel || st.get().browse) return;
  const path = sel.side === "deletions" ? (file.prevName ?? file.name) : file.name;
  st.set({ asking: { path, side: sel.side, start: sel.start, end: sel.end }, peek: null });
}

/** Sends the question; a follow-up continues the same conversation. */
export async function ask(question: string, lines = st.get().asking) {
  if (!lines || !question.trim()) return;
  // A question here is about these lines now, not a reopened conversation from before.
  const at = { path: lines.path, side: lines.side, start: lines.start, end: lines.end };
  if (st.get().asking?.thread) st.set({ asking: at });
  // A follow-up continues the lines' conversation, even one from earlier in the review.
  const prev = st.get().job;
  const followUp =
    st.threadAt(at)?.sessionId ??
    (prev?.kind === "ask" &&
    prev.at &&
    prev.at.path === at.path &&
    prev.at.start === at.start &&
    prev.at.end === at.end &&
    !st.get().asks.some((t) => t.outdated && t.sessionId === prev.sessionId)
      ? prev.sessionId
      : null);
  try {
    const { job } = await api.ask({ ...at, question, followUp });
    st.set({ job, agentActivity: [] });
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't ask Claude.");
  }
}

/** Turns an answer into your draft comment on the same lines, open to edit. */
export function commentFromAnswer(answer: string) {
  const { asking: at } = st.get();
  if (!at || !answer.trim()) return;
  st.set({
    anchor: at.start === at.end ? null : { side: at.side, line: at.start },
    cursor: { side: at.side, line: at.end },
    asking: null,
  });
  st.startComment();
  const id = st.get().editing;
  if (id) st.updateDraft(id, { body: answer.trim() });
}

/** Accepting makes Claude's proposal your draft: it posts and applies like any other. */
export function accept(id: string) {
  const d = st.get().drafts.find((x) => x.id === id);
  if (d?.proposal) st.replaceDraft({ ...d, proposal: null });
}

/** Follows the server's agent stream for the life of the page; reconnects on its own. */
export function connect() {
  void api.agent().then(
    ({ run }) => st.set({ agent: run }),
    () => {},
  );
  const source = new EventSource("/api/agent/events");
  void api.job().then(
    ({ job }) => job && st.set({ job }),
    () => {},
  );
  source.onmessage = (m) => {
    const e = JSON.parse(m.data) as AgentEvent;
    if (e.type === "run") return onRun(e.run);
    if (e.type === "job") return onJob(e.job);
    if (e.type === "delta")
      return st.set((s) => (s.job?.state === "running" ? { job: { ...s.job, answer: s.job.answer + e.text } } : {}));
    const item =
      e.type === "tool"
        ? { kind: "tool" as const, tool: e.tool, target: e.target }
        : { kind: "text" as const, text: e.text };
    st.set((s) => ({ agentActivity: [...s.agentActivity, item].slice(-MAX_ACTIVITY) }));
  };
  return () => source.close();
}

/** Hands the drafts (all, or some) to Claude. */
export async function apply(ids?: string[]) {
  try {
    const { run } = await api.applyAgent(ids);
    st.set({ agent: run, agentActivity: [], agentOpen: true, reviewOpen: false });
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't start Claude.");
  }
}

export function stop() {
  void api.stopAgent().catch(() => {});
}

/** Puts back what the last pass changed; files you edited since are kept and named. */
export async function undo() {
  try {
    const r = await api.undoAgent();
    st.set({ view: "review" });
    await st.load();
    st.toast(
      r.kept.length
        ? `Undid ${r.restored.length} files; kept ${r.kept.join(", ")} (edited since)`
        : `Undid Claude's changes to ${r.restored.length} ${r.restored.length === 1 ? "file" : "files"}`,
    );
  } catch (e) {
    st.fail(e instanceof Error ? e.message : "Couldn't undo.");
  }
}

export function showChanges() {
  st.set({ view: "agent", agentOpen: false, browse: null, peek: null });
}
