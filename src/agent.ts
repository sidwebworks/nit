import { isAbsolute, relative, resolve } from "node:path";
import {
  createSdkMcpServer,
  type HookCallback,
  query,
  type SDKAssistantMessageError,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { runCodex } from "./codex";
import { within } from "./git";
import type { Guidelines } from "./guidelines";
import { claudeOptions, prefsOf, savedKey } from "./prefs";
import type { Snapshots } from "./snapshot";
import type { Store } from "./store";
import {
  type AgentEvent,
  type AgentOutcome,
  type AgentRun,
  API_KEY_ERROR,
  type Draft,
  type Job,
  SIGN_IN_ERROR,
} from "./types";

/**
 * Applies review comments with the Claude Agent SDK, on the Claude Code login already on this
 * machine. The agent reads and edits files in the checkout and nothing else: no shell, no
 * settings files (a repo's hooks are shell commands), and a hook that refuses any path
 * outside the checkout. Snapshots before and after give its exact changes and undo.
 */

// Searching goes through nit's fff tools (grep, multi_grep, find_files) for every pass: Claude
// Code's Glob and Grep aren't offered.
const TOOLS = ["Read", "Edit", "Write"];
const READ_TOOLS = ["Read"];

// What to do about the errors a reviewer can fix; the rest keep Claude Code's own words.
const WHY: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: SIGN_IN_ERROR,
  rate_limit: "You've reached your Claude usage limit. Try again when it resets.",
  overloaded: "Claude is overloaded right now. Try again in a minute.",
  billing_error: "Your Claude account has a billing problem. Check it at claude.ai, then try again.",
};

/** The failure a message reports (an API error, or a turn that ended on one), else null. */
export function failureOf(m: SDKMessage, usingKey = false): string | null {
  if (m.type === "assistant" && m.error) {
    const text = m.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    if (m.error === "authentication_failed" && usingKey) return API_KEY_ERROR;
    return WHY[m.error] ?? (text.trim() || m.error);
  }
  if (m.type === "result" && m.is_error) return m.subtype === "success" ? m.result : m.errors.join("; ") || m.subtype;
  return null;
}

const INSTRUCTIONS = `You are applying a reviewer's comments to this checkout. Each comment sits on lines of one file.

For each comment:
- Make the smallest change that does what it asks, in the code's own style and within the rules in <guidelines>.
- To find code, use grep, multi_grep or find_files, then Read; make independent searches together in one turn.
- A <suggestion> is the exact replacement for its lines: apply its text as written.
- A question, or a comment you can't act on safely, gets its answer in the note and leaves the code as it is.
- Keep every other line as it is. You edit files; running commands and committing stay with the reviewer.

Done when every comment has an outcome: its id, "done", "skipped" or "question", and a one-sentence note on what you changed or why not.`;

const OUTCOMES = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      outcomes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["done", "skipped", "question"] },
            note: { type: "string" },
          },
          required: ["id", "status", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["outcomes"],
    additionalProperties: false,
  },
};

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

/** The drafts as the agent reads them: where, what the lines were, the comment, any suggestion. */
export function promptFor(drafts: Draft[]) {
  const items = drafts.map((d) => {
    const where = d.start === 0 ? "the whole file" : d.start === d.end ? `line ${d.end}` : `lines ${d.start}-${d.end}`;
    const side = d.side === "deletions" ? " (removed in this change)" : "";
    const lines = d.anchor.length ? `\n<lines>\n${xml(d.anchor.join("\n"))}\n</lines>` : "";
    const suggestion = d.suggestion !== null ? `\n<suggestion>\n${xml(d.suggestion)}\n</suggestion>` : "";
    return `<comment id="${d.id}" file="${xml(d.path)}" at="${where}${side}">${lines}\n${xml(d.body.trim())}${suggestion}\n</comment>`;
  });
  return `Apply these ${drafts.length} review comments.\n\n${items.join("\n\n")}`;
}

/**
 * A PreToolUse hook for every file tool, whatever settings say: nothing outside the checkout,
 * nothing in its .git. Shared by Apply and Ask.
 */
export function confineTo(root: string, opts: { guidelinesFromBase?: boolean } = {}): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    // Glob's pattern and Grep's glob can name a directory too ("/etc/*", "../x/**"): the part
    // before the first wildcard is checked like any path.
    const pattern = input.tool_name === "Glob" ? args.pattern : input.tool_name === "Grep" ? args.glob : undefined;
    const fixed = typeof pattern === "string" ? pattern.split(/[*?[{]/)[0] : "";
    const patternDir = isAbsolute(fixed) || fixed.split("/").includes("..") ? fixed || "/" : "";
    if (patternDir && !within(root, patternDir))
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `nit only allows files inside the review checkout (${root}), not ${pattern}.`,
        },
      };
    for (const key of ["file_path", "path", "notebook_path"]) {
      const p = args[key];
      if (typeof p !== "string" || !p) continue;
      const rel = relative(root, resolve(root, p));
      // Reviewing: the checkout's guideline files may be the PR's edits; the rules are the base's.
      if (opts.guidelinesFromBase && input.tool_name === "Read" && isGuidelineFile(rel))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `This pull request may change ${rel}. Use read_guideline("${rel}") for the base branch's rules.`,
          },
        };
      if (!within(root, p) || rel === ".git" || rel.startsWith(".git/"))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `nit only allows files inside the review checkout (${root}), not ${p}.`,
          },
        };
    }
    return {};
  };
}

const isGuidelineFile = (rel: string) =>
  /(^|\/)(AGENTS|CLAUDE|REVIEW|BUGBOT)\.md$/.test(rel) ||
  rel.startsWith(".claude/rules/") ||
  rel.startsWith(".github/instructions/") ||
  rel === ".github/copilot-instructions.md";

/** What a tool call is about, for progress: the file it touches or what it looks for. */
export function targetOf(root: string, input: Record<string, unknown>) {
  const p = (input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    (Array.isArray(input.patterns) ? input.patterns.join(" | ") : "")) as string;
  return isAbsolute(p) ? relative(root, p) || "." : p;
}

export function createAgent(root: string, snapshots: Snapshots, store: Store) {
  // Whether this pass bills nit's saved API key (Settings → AI), set as each one starts; one
  // pass runs at a time.
  let keyed = false;
  const usingKey = () => keyed;
  const decideKey = async () => {
    const wantsKey = prefsOf(store).auth === "apiKey";
    keyed = wantsKey && !!(await savedKey());
    // Asked for an API key and there's none: say so, rather than quietly using the login.
    if (wantsKey && !keyed)
      throw new Error(
        "Settings → AI is set to sign in with an API key, but none is saved. Add one there, or switch back to the Claude Code login.",
      );
  };
  let current: { run: AgentRun; abort: AbortController; events: AgentEvent[] } | null = null;
  const listeners = new Set<(e: AgentEvent) => void>();
  let replayed: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    replayed.push(e);
    for (const l of listeners) l(e);
  };
  const save = (run: AgentRun) => {
    store.setAgentRun(run);
    emit({ type: "run", run });
  };

  const confine = confineTo(root);
  const confineReview = confineTo(root, { guidelinesFromBase: true });
  let job: { job: Job; abort: AbortController } | null = null;
  const busy = () => current !== null || job !== null;
  const announce = (j: Job) => emit({ type: "job", job: j });

  return {
    /** The run in progress, else the last one for this review. */
    state: (): AgentRun | null => current?.run ?? store.agentRun(),
    /** The co-review or question in progress. */
    job: (): Job | null => job?.job ?? null,
    /** Events of the run in progress so far, for a page that connects midway. */
    replay: (): AgentEvent[] => (busy() ? replayed : []),
    subscribe(l: (e: AgentEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    stop() {
      current?.abort.abort();
      job?.abort.abort();
    },

    /** Starts a pass over `drafts`. One at a time; resolves when it has started. */
    async start(
      drafts: Draft[],
      context: { guidelines: string; tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]> },
    ): Promise<AgentRun> {
      if (busy()) throw new Error("AI is already working on this review.");
      const previous = store.agentRun();
      const run: AgentRun = {
        id: crypto.randomUUID(),
        drafts: drafts.map((d) => d.id),
        startedAt: Date.now(),
        endedAt: null,
        state: "running",
        before: await snapshots.take(),
        after: null,
        files: [],
        outcomes: [],
        error: null,
        costUsd: null,
        // A follow-up pass continues the same conversation, unless the last one was undone.
        sessionId: previous && previous.state !== "undone" ? previous.sessionId : null,
      };
      const abort = new AbortController();
      current = { run, abort, events: [] };
      replayed = current.events;
      save(run);
      void this.work(run, drafts, abort, context);
      return run;
    },

    async work(
      run: AgentRun,
      drafts: Draft[],
      abort: AbortController,
      context: { guidelines: string; tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]> },
    ) {
      try {
        await decideKey();
        const messages = query({
          prompt: [promptFor(drafts), context.guidelines].filter(Boolean).join("\n\n"),
          options: {
            cwd: root,
            tools: TOOLS,
            allowedTools: [...TOOLS, ...context.tools.map((t) => `mcp__nit__${t.name}`)],
            mcpServers: { nit: createSdkMcpServer({ name: "nit", tools: context.tools }) },
            settingSources: [],
            ...(await claudeOptions(prefsOf(store), "apply")),
            systemPrompt: { type: "preset", preset: "claude_code", append: INSTRUCTIONS },
            hooks: { PreToolUse: [{ hooks: [confine] }] },
            outputFormat: OUTCOMES,
            abortController: abort,
            ...(run.sessionId ? { resume: run.sessionId } : {}),
          },
        });
        for await (const m of messages as AsyncIterable<SDKMessage>) this.read(run, m);
        run.state = abort.signal.aborted ? "stopped" : run.error ? "failed" : "done";
      } catch (e) {
        run.state = abort.signal.aborted ? "stopped" : "failed";
        if (!abort.signal.aborted) run.error ??= e instanceof Error ? e.message : String(e);
      } finally {
        run.after = await snapshots.take().catch(() => null);
        run.files = run.after ? await snapshots.changed(run.before, run.after).catch(() => []) : [];
        run.endedAt = Date.now();
        current = null;
        save(run);
      }
    },

    /** Turns one SDK message into progress events and the run's results. */
    read(run: AgentRun, m: SDKMessage) {
      if ("session_id" in m && m.session_id && run.sessionId !== m.session_id) run.sessionId = m.session_id;
      const failed = failureOf(m, usingKey());
      if (failed) {
        run.error ??= failed;
        return;
      }
      if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) emit({ type: "text", text: block.text.trim() });
          // StructuredOutput is how the SDK returns the outcomes, not work on the code.
          if (block.type === "tool_use" && block.name !== "StructuredOutput")
            emit({ type: "tool", tool: block.name, target: targetOf(root, block.input as Record<string, unknown>) });
        }
      } else if (m.type === "result") {
        // On a Claude subscription nothing is billed per token: the SDK's estimate would only
        // alarm. With an API key it's real money, so it's shown.
        run.costUsd = usingKey() ? m.total_cost_usd : null;
        if (m.subtype === "success") {
          const out = (m.structured_output as { outcomes?: AgentOutcome[] } | undefined)?.outcomes ?? [];
          run.outcomes = out.filter((o) => run.drafts.includes(o.id));
        } else run.error ??= m.errors.join("; ") || m.subtype;
      }
    },

    /**
     * A read-only job: Read, Glob and Grep in the checkout, plus nit's own tools; guidelines only
     * from the base branch. `finish` turns the structured result (if any) into the job's outcome.
     */
    async runJob(
      kind: Job["kind"],
      o: {
        prompt: string;
        instructions: string;
        guidelines: Guidelines;
        tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;
        outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
        at?: Job["at"];
        question?: string;
        resume?: string | null;
        finish?: (structured: unknown, j: Job) => Promise<void>;
      },
    ): Promise<Job> {
      if (busy()) throw new Error("AI is already working on this review.");
      const j: Job = {
        id: crypto.randomUUID(),
        kind,
        state: "running",
        startedAt: Date.now(),
        endedAt: null,
        error: null,
        found: 0,
        dropped: [],
        summary: null,
        at: o.at ?? null,
        question: o.question ?? null,
        answer: "",
        sessionId: o.resume ?? null,
        guidelines: { inline: o.guidelines.inline.map((d) => d.path), indexed: o.guidelines.indexed.length },
      };
      const abort = new AbortController();
      job = { job: j, abort };
      replayed = [];
      announce(j);
      const server = createSdkMcpServer({ name: "nit", tools: o.tools });
      const names = o.tools.map((t) => `mcp__nit__${t.name}`);
      void (async () => {
        let structured: unknown;
        try {
          const prefs = prefsOf(store);
          if (prefs.reviewer === "codex") {
            const r = await runCodex({
              root,
              prefs,
              kind,
              prompt: o.prompt,
              instructions: o.instructions,
              tools: o.tools,
              schema: o.outputFormat?.schema,
              // Each reviewer resumes only its own conversations ("codex-" marks Codex's).
              resume: o.resume?.startsWith("codex-") ? o.resume.slice(6) : null,
              signal: abort.signal,
              onSession: (id) => {
                j.sessionId = `codex-${id}`;
              },
              onTool: (tool, target) => emit({ type: "tool", tool, target }),
              onText: (text) => {
                j.answer = text;
                emit({ type: "text", text });
              },
            });
            j.error ??= r.error;
            structured = r.structured;
            if (kind === "ask") j.answer = r.answer;
            if (!abort.signal.aborted && !j.error) await o.finish?.(structured, j);
            j.state = abort.signal.aborted ? "stopped" : j.error ? "failed" : "done";
            return;
          }
          await decideKey();
          const messages = query({
            prompt: o.prompt,
            options: {
              cwd: root,
              tools: READ_TOOLS,
              allowedTools: [...READ_TOOLS, ...names],
              mcpServers: { nit: server },
              settingSources: [],
              ...(await claudeOptions(prefsOf(store), kind)),
              systemPrompt: { type: "preset", preset: "claude_code", append: o.instructions },
              hooks: { PreToolUse: [{ hooks: [confineReview] }] },
              includePartialMessages: kind === "ask",
              abortController: abort,
              ...(o.outputFormat ? { outputFormat: o.outputFormat } : {}),
              ...(o.resume && !o.resume.startsWith("codex-") ? { resume: o.resume } : {}),
            },
          });
          for await (const m of messages as AsyncIterable<SDKMessage>) {
            if ("session_id" in m && m.session_id) j.sessionId = m.session_id;
            const failed = failureOf(m, usingKey());
            if (failed) {
              j.error ??= failed;
              continue;
            }
            if (m.type === "stream_event") {
              const e = m.event;
              if (e.type === "content_block_delta" && e.delta.type === "text_delta" && !m.parent_tool_use_id) {
                j.answer += e.delta.text;
                emit({ type: "delta", text: e.delta.text });
              }
            } else if (m.type === "assistant") {
              for (const block of m.message.content)
                if (block.type === "tool_use" && block.name !== "StructuredOutput")
                  emit({
                    type: "tool",
                    tool: block.name.replace(/^mcp__nit__/, ""),
                    target: targetOf(root, block.input as Record<string, unknown>),
                  });
                // A new assistant turn after tools: the streamed answer restarts there.
                else if (block.type === "text" && kind === "ask") j.answer = block.text;
            } else if (m.type === "result") {
              if (m.subtype === "success") {
                structured = m.structured_output;
                if (kind === "ask" && m.result) j.answer = m.result;
              } else j.error ??= m.errors.join("; ") || m.subtype;
            }
          }
          if (!abort.signal.aborted && !j.error) await o.finish?.(structured, j);
          j.state = abort.signal.aborted ? "stopped" : j.error ? "failed" : "done";
        } catch (e) {
          j.state = abort.signal.aborted ? "stopped" : "failed";
          if (!abort.signal.aborted) j.error ??= e instanceof Error ? e.message : String(e);
        } finally {
          j.endedAt = Date.now();
          job = null;
          announce(j);
        }
      })();
      return j;
    },

    /** Puts back what the last pass changed, except files edited since. */
    async undo() {
      const run = store.agentRun();
      if (!run?.after || current) throw new Error("There's no finished agent pass to undo.");
      if (run.state === "undone") throw new Error("That pass is already undone.");
      const result = await snapshots.undo(run.before, run.after);
      run.state = "undone";
      save(run);
      return result;
    },

    /** The last pass's changes as a patch, for the "agent's changes" view. */
    async changes() {
      const run = store.agentRun();
      return run?.after ? snapshots.diff(run.before, run.after) : "";
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
