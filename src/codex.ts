import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { $ } from "bun";
import { childEnv } from "./child-env";
import { compiled } from "./embedded";
import type { NitTools } from "./mcp-http";
import { openTools } from "./mcp-http";
import { CODEX_KEY_ERROR, CODEX_SIGN_IN_ERROR, type CodexStatus, type Prefs } from "./types";

/**
 * Codex as a reviewer, through OpenAI's Codex SDK: it runs the `codex` binary (the one you
 * installed, else the one the SDK brings) on your own Codex sign-in or an OpenAI key saved in
 * nit. Questions, the reading guide and co-review run in Codex's read-only sandbox, with nit's
 * own tools served to it over MCP.
 */

const KEY = { service: "nit", name: "openai-api-key" };
let key: Promise<string | null> | undefined;
export const savedCodexKey = () => {
  key ??= Bun.secrets.get(KEY).catch(() => null);
  return key;
};
export async function saveCodexKey(value: string | null) {
  if (value) await Bun.secrets.set({ ...KEY, value });
  else await Bun.secrets.delete(KEY);
  key = Promise.resolve(value);
}

/** The codex binary: yours on PATH, else the SDK's own (run from source only; the single binary doesn't carry it). */
export function codexBinary(): string | null {
  const yours = Bun.which("codex");
  if (yours || compiled()) return yours;
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  try {
    const pkg = createRequire(import.meta.url).resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    );
    const bin = join(dirname(pkg), "vendor", triple, "bin", "codex");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Whether Codex can run: installed, and signed in (`codex login status`) or given a key. */
export async function codexStatus(): Promise<CodexStatus> {
  const hasKey = !!(await savedCodexKey());
  const bin = codexBinary();
  if (!bin) return { installed: false, loggedIn: false, method: null, hasKey };
  const r = await $`${bin} login status`
    .env(childEnv() as Record<string, string>)
    .nothrow()
    .quiet();
  const text = `${r.stdout}${r.stderr}`.trim();
  const loggedIn = r.exitCode === 0 && !/not logged in/i.test(text);
  return {
    installed: true,
    loggedIn,
    method: loggedIn ? (/chatgpt/i.test(text) ? "ChatGPT" : /api key/i.test(text) ? "API key" : null) : null,
    hasKey,
  };
}

/** What a failed Codex run means for the reviewer, in nit's words where we know them. */
export function codexFailure(message: string, usingKey: boolean): string {
  if (/401|unauthori[sz]ed|not logged in|login required|invalid api key|incorrect api key/i.test(message))
    return usingKey ? CODEX_KEY_ERROR : CODEX_SIGN_IN_ERROR;
  if (/429|rate limit|usage limit/i.test(message))
    return "You've reached your Codex usage limit. Try again when it resets.";
  return message;
}

export type CodexJob = {
  root: string;
  prefs: Prefs;
  kind: "ask" | "review" | "guide";
  prompt: string;
  instructions: string;
  tools: NitTools;
  schema?: Record<string, unknown>;
  resume?: string | null;
  signal: AbortSignal;
  onSession: (id: string) => void;
  onTool: (tool: string, target: string) => void;
  /** A whole message from Codex (it doesn't stream tokens): the answer so far. */
  onText: (text: string) => void;
};

/** One read-only Codex turn. Resolves to its structured output (with a schema) or its answer. */
export async function runCodex(o: CodexJob): Promise<{ structured?: unknown; answer: string; error: string | null }> {
  const usingKey = o.prefs.codexAuth === "apiKey";
  const apiKey = usingKey ? await savedCodexKey() : null;
  if (usingKey && !apiKey)
    throw new Error(
      "Settings → Reviewer is set to use an OpenAI API key for Codex, but none is saved. Add one there, or switch to your Codex sign-in.",
    );
  const bin = codexBinary();
  if (!bin)
    throw new Error(
      "nit needs Codex for this. Install it (npm i -g @openai/codex, or brew install codex) and try again.",
    );
  // Not signed in, Codex retries five times over half a minute before it gives up: ask first.
  if (!usingKey && !(await codexStatus()).loggedIn) throw new Error(CODEX_SIGN_IN_ERROR);

  const tools = openTools(o.tools);
  try {
    const codex = new Codex({
      codexPathOverride: bin,
      // Its own logs go to stderr, which reaches nit's terminal; its errors still come as events.
      env: { ...(childEnv() as Record<string, string>), RUST_LOG: "off" },
      ...(apiKey ? { apiKey } : {}),
      config: {
        // Only nit's tools, read-only: its MCP endpoint for this run, nothing to approve.
        mcp_servers: {
          nit: {
            url: tools.url,
            http_headers: { Authorization: `Bearer ${tools.token}` },
            startup_timeout_sec: 10,
            tool_timeout_sec: 60,
          },
        },
      },
    });
    const effort =
      o.prefs.codexEffort !== "default" ? o.prefs.codexEffort : o.kind === "review" ? undefined : ("low" as const);
    const options: ThreadOptions = {
      workingDirectory: o.root,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchEnabled: false,
      ...(o.prefs.codexModel ? { model: o.prefs.codexModel } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
    };
    const thread = o.resume ? codex.resumeThread(o.resume, options) : codex.startThread(options);
    // Codex has no system prompt to add to: a new conversation starts with nit's instructions.
    const input = o.resume ? o.prompt : `${o.instructions}\n\n${o.prompt}`;
    // Stopping the job stops Codex; so does a sign-in it can't recover from.
    const stop = new AbortController();
    o.signal.addEventListener("abort", () => stop.abort(), { once: true });
    const { events } = await thread.runStreamed(input, {
      ...(o.schema ? { outputSchema: o.schema } : {}),
      signal: stop.signal,
    });

    let answer = "";
    let error: string | null = null;
    try {
      for await (const e of events as AsyncIterable<ThreadEvent>) {
        if (e.type === "thread.started") o.onSession(e.thread_id);
        else if (e.type === "item.started" && e.item.type === "mcp_tool_call")
          o.onTool(e.item.tool, targetOf(e.item.arguments));
        else if (e.type === "item.started" && e.item.type === "command_execution") o.onTool("shell", e.item.command);
        else if (e.type === "item.completed" && e.item.type === "agent_message") {
          answer = e.item.text;
          if (!o.schema) o.onText(answer);
        } else if (e.type === "turn.failed") error = codexFailure(e.error.message, usingKey);
        else if (e.type === "error") {
          // "Reconnecting... 2/5" is Codex retrying; a refused sign-in won't get better.
          const why = codexFailure(e.message, usingKey);
          if (why === CODEX_SIGN_IN_ERROR || why === CODEX_KEY_ERROR) {
            error = why;
            stop.abort();
            break;
          }
          if (!/^Reconnecting/i.test(e.message)) error = why;
        }
      }
    } catch (e) {
      // The SDK throws when codex exits non-zero: its message carries codex's stderr.
      if (!error && !o.signal.aborted) error = codexFailure(e instanceof Error ? e.message : String(e), usingKey);
    }
    if (error || !o.schema) return { answer, error };
    try {
      return { structured: JSON.parse(answer), answer, error };
    } catch {
      return { answer, error: "Codex's answer wasn't the structured result nit asked for. Try again." };
    }
  } finally {
    tools.close();
  }
}

const targetOf = (args: unknown) => {
  const a = (args ?? {}) as Record<string, unknown>;
  const t = a.path ?? a.query ?? (Array.isArray(a.patterns) ? a.patterns.join(" | ") : "");
  return typeof t === "string" ? t : "";
};
