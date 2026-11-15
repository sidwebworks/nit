import { homedir } from "node:os";
import type { AgentEvent, AgentRun, Job } from "./types";

/**
 * Terminal output, kept plain: progress on stdout (stderr renders red in many terminals, so
 * normal steps looked like errors), failures alone on stderr in red. No colour when output
 * isn't a terminal or NO_COLOR is set.
 */
const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint("2"),
  bold: paint("1"),
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  cyan: paint("36"),
};

const out = (s = "") => process.stdout.write(`${s}\n`);
export const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const width = () => Math.max(40, process.stdout.columns ?? 80);
const fit = (s: string, room: number) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);

/** A step on the way to the review, dim: "· creating a worktree at …". */
export const step = (msg: string) => print(`  ${c.dim(`· ${msg}`)}`);
const warned = new Set<string>();
/** A warning, once per run: config is re-read often (settings, opening the editor). */
export const warn = (msg: string) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  print(`  ${c.yellow("!")} ${msg}`);
};

/** A failure someone can act on: what went wrong, why, and what to do about it. */
export class NitError extends Error {
  constructor(
    message: string,
    readonly why?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const debug = process.env.NIT_DEBUG === "1";
const ISSUES = "https://github.com/sidwebworks/nit/issues";

/**
 * Any error as a NitError: GitHub's (401, 403, 404, rate limits), the network's, and git's
 * get plain words and a next step; anything else is a bug in nit, and says where to report it.
 */
export function explain(e: unknown): NitError {
  if (e instanceof NitError) return e;
  const err = e as { status?: number; code?: string; message?: string; stderr?: { toString(): string } };
  const message = err?.message ?? String(e);
  if (typeof err?.status === "number") {
    if (err.status === 401)
      return new NitError(
        "GitHub didn't accept your sign-in",
        "The token nit used is missing, expired or revoked.",
        "Run `gh auth login`, or save a token in nit's Settings → GitHub.",
      );
    if (err.status === 403 || err.status === 429)
      return new NitError(
        "GitHub refused the request",
        message.split(" - ")[0],
        /rate limit/i.test(message) ? "Wait a few minutes and try again." : "Check the token can read this repository.",
      );
    if (err.status === 404)
      return new NitError(
        "GitHub couldn't find that",
        "It doesn't exist, or the token can't see it.",
        "Check the repository and number, and that you're signed in to the right account.",
      );
  }
  if (
    ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ConnectionRefused"].includes(err?.code ?? "") ||
    /fetch failed|Unable to connect/i.test(message)
  )
    return new NitError("Couldn't reach GitHub", message, "Check your connection, then try again.");
  // Bun's shell errors carry the command's stderr, which says more than "exit code 128".
  const stderr = err?.stderr?.toString().trim();
  if (stderr) return new NitError("A git command failed", stderr.split("\n").slice(-3).join(" "), undefined);
  return new NitError(
    message,
    "This looks like a bug in nit.",
    `Run with NIT_DEBUG=1 for details, and report it at ${ISSUES}`,
  );
}

const wrap = (text: string, room: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > room) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
};

/** The red block for a failure: what went wrong in bold, why under it, then what to do. */
function block(err: NitError, original: unknown) {
  const room = Math.max(60, Math.min(width(), 100) - 6);
  const lines = [`  ${c.red("✕")} ${c.bold(err.message)}`];
  if (err.why) for (const l of wrap(err.why, room)) lines.push(`    ${c.dim(l)}`);
  if (err.hint) lines.push(`    ${c.cyan("→")} ${err.hint}`);
  if (debug && original instanceof Error && original.stack) lines.push("", c.dim(original.stack));
  return lines;
}

/** Stops nit with what went wrong, why, and what to do. */
export function fail(e: unknown): never {
  stopTicker();
  clearFooter();
  // The header already left a blank line; otherwise start with one.
  process.stderr.write(
    `${headed ? "" : "\n"}${block(typeof e === "string" ? new NitError(e) : explain(e), e).join("\n")}\n\n`,
  );
  process.exit(1);
}

/** Something went wrong while nit runs (a request, a background job): logged, and nit carries on. */
export function error(e: unknown) {
  const err = explain(e);
  const [first, ...rest] = block(err, e);
  log(
    first.trim(),
    rest.map((l) => l.trim()),
  );
}

/** "nit 0.1.0", before anything else. */
let headed = false;
export const header = (version: string) => {
  headed = true;
  out(`\n  ${c.bold("nit")} ${c.dim(version)}\n`);
};

/**
 * One step of getting the review ready: a spinner while it runs, then a tick (or a cross) and
 * how long it took. `done` can say what it found.
 */
export async function task<T>(label: string, fn: () => Promise<T>, done?: (r: T) => string): Promise<T> {
  const since = Date.now();
  let frame = 0;
  const draw = () => tty && process.stdout.write(`\r\x1b[2K  ${c.cyan(SPIN[frame++ % SPIN.length])} ${label}…`);
  draw();
  const spin = tty ? setInterval(draw, 80) : undefined;
  try {
    const r = await fn();
    clearInterval(spin);
    clearFooter();
    const ms = Date.now() - since;
    out(`  ${c.green("✓")} ${done ? done(r) : label}${ms >= 150 ? `  ${c.dim(seconds(ms))}` : ""}`);
    return r;
  } catch (e) {
    clearInterval(spin);
    clearFooter();
    out(`  ${c.red("✕")} ${label}`);
    throw e;
  }
}
const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/** `nit --help`. */
export function help(version: string) {
  const row = (cmd: string, what: string) => `    ${cmd.padEnd(20)}${c.dim(what)}`;
  out(
    [
      "",
      `  ${c.bold("nit")} ${c.dim(version)}  keyboard-first code review`,
      "",
      `  ${c.bold("Usage")}`,
      row("nit", "review this branch against its default base"),
      row("nit <branch>", "review it against another branch or commit"),
      row("nit <pr>", "review a pull request: 2234, #2234 or its URL"),
      "",
      `  ${c.bold("Options")}`,
      row("-h, --help", "show this"),
      row("-v, --version", "print the version"),
      "",
      `  ${c.bold("Environment")}`,
      row("NIT_PORT", "the port to serve on"),
      row("NIT_NO_OPEN=1", "don't open the browser"),
      row("NIT_DEBUG=1", "show stack traces with errors"),
      "",
      `  ${c.dim("https://sidwebworks.com/things/nit")}`,
      "",
    ].join("\n"),
  );
}

// ---------- while nit runs: a log of what happened, and one status line under it (TTY only)

const tty = process.stdout.isTTY === true;
const clock = () => new Date().toTimeString().slice(0, 5);
let hint = ""; // the keys, shown when nothing is running
let activity: { label: string; since: number; detail: string } | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function footer() {
  if (!activity) return hint;
  const secs = Math.round((Date.now() - activity.since) / 1000);
  const rest = [activity.label, duration(secs), activity.detail].filter(Boolean).join(" · ");
  return `  ${c.cyan(SPIN[Math.floor(Date.now() / 80) % SPIN.length])} ${c.dim(fit(rest, width() - 6))}`;
}
const redraw = () => tty && process.stdout.write(`\r\x1b[2K${footer()}`);
const clearFooter = () => tty && process.stdout.write("\r\x1b[2K");

/** One timestamped line (and dim detail lines) above the status line. */
export function log(msg: string, detail: string[] = []) {
  clearFooter();
  out(`  ${c.dim(clock())}  ${msg}`);
  for (const d of detail) out(`         ${d}`);
  redraw();
}

/** A plain line above the status line (it's cleared first and drawn again after). */
function print(line: string) {
  clearFooter();
  out(line);
  redraw();
}

const duration = (secs: number) => (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
const took = (from: number, to: number | null) => c.dim(duration(Math.round(((to ?? from) - from) / 1000)));

/** Claude is working: the status line spins and says on what until `idle()`. */
function busy(label: string, since: number) {
  activity = { label, since, detail: "" };
  ticker ??= setInterval(redraw, 80);
  ticker.unref?.();
  redraw();
}
function stopTicker() {
  clearInterval(ticker);
  ticker = undefined;
}
function idle() {
  activity = null;
  stopTicker();
  redraw();
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const where = (j: Job) => (j.at ? `${j.at.path}:${j.at.start}${j.at.end !== j.at.start ? `-${j.at.end}` : ""}` : "");
const failed = (what: string, error: string | null) => log(`${c.red("✕")} ${what}: ${error ?? "unknown error"}`);

const running = new Set<string>();
function job(j: Job) {
  const who = j.reviewer === "codex" ? "Codex" : "Claude";
  const what =
    j.kind === "review"
      ? `${who} reviewing the diff`
      : j.kind === "guide"
        ? `${who} ordering the files`
        : `${who} answering about ${where(j)}`;
  if (j.state === "running") {
    if (!running.has(j.id)) {
      running.add(j.id);
      log(`${c.dim("·")} ${what}`);
      busy(what, j.startedAt);
    }
    return;
  }
  if (!running.delete(j.id)) return;
  idle();
  if (j.state === "stopped") return log(`${c.dim("·")} stopped ${took(j.startedAt, j.endedAt)}`);
  if (j.state === "failed")
    return failed(j.kind === "review" ? "co-review" : j.kind === "guide" ? "guide" : "question", j.error);
  if (j.kind === "guide") return log(`${c.green("✓")} ordered the files ${took(j.startedAt, j.endedAt)}`);
  if (j.kind === "ask") return log(`${c.green("✓")} answered ${took(j.startedAt, j.endedAt)}`);
  const dropped = j.dropped.length ? c.dim(` · ${j.dropped.length} dropped by checks`) : "";
  log(`${c.green("✓")} proposed ${plural(j.found, "comment")}${dropped} ${took(j.startedAt, j.endedAt)}`);
}

function run(r: AgentRun) {
  const what = `Claude applying ${plural(r.drafts.length, "comment")}`;
  if (r.state === "running") {
    if (!running.has(r.id)) {
      running.add(r.id);
      log(`${c.dim("·")} ${what}`);
      busy(what, r.startedAt);
    }
    return;
  }
  if (!running.delete(r.id)) return;
  idle();
  if (r.state === "stopped")
    return log(`${c.dim("·")} stopped; what Claude changed is kept ${took(r.startedAt, r.endedAt)}`);
  if (r.state === "failed") return failed("apply", r.error);
  const done = r.outcomes.filter((o) => o.status === "done").length;
  log(
    `${c.green("✓")} applied ${done} of ${r.drafts.length} · ${plural(r.files.length, "file")} changed ${took(r.startedAt, r.endedAt)}`,
  );
}

/** Narrates the agent's events: a line when a pass starts and ends, its tools on the status line. */
export function agent(e: AgentEvent) {
  if (e.type === "job") job(e.job);
  else if (e.type === "run") run(e.run);
  else if (e.type === "tool" && activity) {
    activity.detail = `${e.tool.replace(/^mcp__nit__/, "")} ${e.target}`.trim();
    redraw();
  }
}

/** Library warnings (the SDK's, Node's) as one dim line each, not a raw block over the log. */
process.removeAllListeners("warning");
process.on("warning", (w) =>
  log(`${c.yellow("!")} ${c.dim(fit(`${w.name === "Warning" ? "" : `${w.name}: `}${w.message}`, width() - 14))}`),
);
// Leave the shell's prompt on a clean line.
process.on("exit", () => clearFooter());

/** What's under review and where to open it. */
export function banner(o: {
  title: string | null;
  pr: number | null;
  branch: string;
  base: string;
  files: number;
  add: number;
  del: number;
  url: string;
  root: string;
}) {
  const head = o.title ? fit(o.title, width() - 10) : `${o.branch} → ${o.base}`;
  const meta = [
    o.pr ? `#${o.pr}` : null,
    o.title ? `${o.branch} → ${o.base}` : null,
    `${o.files} ${o.files === 1 ? "file" : "files"}`,
  ].filter(Boolean);
  out();
  out(`  ${c.bold(head)}`);
  out(`  ${c.dim(meta.join("  ·  "))}  ${c.green(`+${o.add}`)} ${c.red(`−${o.del}`)}`);
  out();
  out(`  ${c.green("➜")}  ${c.cyan(o.url)}`);
  out(`     ${c.dim(tilde(o.root))}`);
  out();
}

/** Single-key shortcuts while nit runs (when stdin is a terminal), shown on the status line. */
export function keys(actions: Record<string, { label: string; run: () => void }>) {
  if (!process.stdin.isTTY) return;
  hint = `  ${Object.entries(actions)
    .map(([k, a]) => `${c.bold(k)} ${c.dim(a.label)}`)
    .join(c.dim("  ·  "))}`;
  redraw();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    // Raw mode swallows the signal, so ⌃C and ⌃D quit here.
    if (key === "\u0003" || key === "\u0004") process.exit(0);
    actions[key.toLowerCase()]?.run();
  });
}
