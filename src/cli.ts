#!/usr/bin/env bun
import { basename, extname, join } from "node:path";
import { type createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";
import { z } from "zod";
import { createAgent } from "./agent";
import { createAuth } from "./auth";
import { buildUI, isStale, uiDirFor } from "./build";
import { categorize } from "./categories";
import { checkoutPr, parsePrArg } from "./checkout";
import { codexStatus, saveCodexKey } from "./codex";
import { commandSettings, openInEditor, saveUserCommands } from "./config";
import {
  ASK_INSTRUCTIONS,
  askPrompt,
  FINDINGS_SCHEMA,
  type Finding,
  fileDiff,
  GUIDE_INSTRUCTIONS,
  GUIDE_SCHEMA,
  guidePrompt,
  locateLines,
  placeGuide,
  proposals,
  REVIEW_INSTRUCTIONS,
  reviewPrompt,
} from "./coreview";
import { compiled, embedded, VERSION } from "./embedded";
import * as git from "./git";
import { createGitHub, account as githubAccount, parseRemote, saveToken } from "./github";
import { changedPaths, type Guidelines, guidelinesBlock, guidelineText, loadGuidelines } from "./guidelines";
import { linearLink, linearRef, savedLinearKey, saveLinearKey } from "./linear";
import { handleTools, setToolBase } from "./mcp-http";
import { createNavigator } from "./navigate";
import { claudeEnv, PrefsPatch, prefsOf, savedKey, saveKey } from "./prefs";
import * as self from "./self";
import { createSnapshots } from "./snapshot";
import { openStore } from "./store";
import * as term from "./term";
import { themeBoot } from "./theme-boot";
import type { AgentEvent, AskThread, Draft, FileContents, GuideChapter, ReviewData, ReviewEvent, Side } from "./types";

const dev = process.env.NIT_DEV === "1";
const uiDir = uiDirFor(dev);

const args = process.argv.slice(2);
// nit looking after itself (self.ts). These work from anywhere, not just a repository.
if (args[0] === "status" || args[0] === "update" || args[0] === "uninstall") {
  const extra = args.slice(1).filter((a) => !(args[0] === "uninstall" && ["--purge", "--yes", "-y"].includes(a)));
  if (extra.length)
    term.fail(
      new term.NitError(`nit ${args[0]} doesn't take ${extra.join(" ")}`, undefined, "See what it takes: nit --help"),
    );
  await (args[0] === "status"
    ? self.status()
    : args[0] === "update"
      ? self.update()
      : self.uninstall(args.slice(1))
  ).catch(term.fail);
  process.exit(0);
}
if (args[0] === "--version" || args[0] === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] === "--help" || args[0] === "-h") {
  term.help(VERSION);
  process.exit(0);
}
if (args[0]?.startsWith("-"))
  term.fail(new term.NitError(`nit doesn't know ${args[0]}`, undefined, "See what it takes: nit --help"));
if (args.length > 1)
  term.fail(
    new term.NitError(
      "nit takes one thing to review",
      `It got ${args.length}: ${args.join(" ")}`,
      "Pass a branch, a commit or a pull request. See nit --help",
    ),
  );

// Until the server is up, anything unexpected stops nit with a readable error; after, it's
// logged and nit keeps serving the review.
let started = false;
const unexpected = (e: unknown) => (started ? term.error(e) : term.fail(e));
process.on("uncaughtException", unexpected);
process.on("unhandledRejection", unexpected);

term.header(VERSION);
/** A file of the browser UI: baked into the binary, or built on disk. */
const uiFile = (path: string) =>
  compiled() ? Bun.file(embedded.ui.get(path) ?? "/nit-missing") : Bun.file(join(uiDir, path));

const here =
  (await git.repoRoot()) ||
  term.fail(
    new term.NitError(
      "This isn't a git repository",
      `${term.tilde(process.cwd())} isn't inside one.`,
      "Run nit from inside the repository you want to review.",
    ),
  );
// `nit 2227`, `nit #2227` or `nit <pr-url>` reviews a pull request in its own worktree.
const arg = args[0];
const prRef = parsePrArg(arg);
const opened = prRef ? await checkoutPr(here, prRef).catch(term.fail) : null;
const root = opened?.path ?? here;
const base = opened?.base ?? (await git.resolveBase(root, arg).catch(term.fail));
const forcedPr = opened?.number ?? (Number(process.env.NIT_PR) || null);
const branch = await git.currentBranch(root);
const mergeBase =
  (await git.mergeBase(root, base)) ||
  term.fail(
    new term.NitError(
      `${branch} and ${base} share no history`,
      "There's no commit both came from, so there's nothing to diff against.",
      "If this is a shallow clone, run `git fetch --unshallow`. Or compare against another branch: nit <branch>",
    ),
  );
const project = await git.projectId(root);
const store = openStore(`${project}:${branch}`);
// Claude's reading order, per review: it holds while the set of files does (placeGuide fills gaps).
const guideKey = `guide:${project}:${branch}`;
// A stable port per repo keeps the tab's address (and its local backups) across restarts.
// The diff is read by the page and by navigation; reuse one read for a couple of seconds.
const patchCache = new Map<boolean, { at: number; text: Promise<string> }>();
/** The review's patch; `ignoreSpace` is the one you read with whitespace changes hidden. */
function patch(ignoreSpace = false) {
  const hit = patchCache.get(ignoreSpace);
  if (hit && Date.now() - hit.at < 2000) return hit.text;
  const text = git.diff(root, mergeBase, ignoreSpace);
  patchCache.set(ignoreSpace, { at: Date.now(), text });
  return text;
}
const nav = await createNavigator(root, mergeBase, patch);
const github = createGitHub(root, branch, forcedPr);
const agent = createAgent(root, createSnapshots(root, project), store);
const authStatus = createAuth(
  () => claudeEnv({ auth: "login" }),
  async () => !!(await savedKey()),
);
agent.subscribe(term.agent);

/** nit's own tools for Claude: guidelines from the base branch, one file's diff, and fff search. */
function claudeTools(
  guidelines: Guidelines,
  text: string,
): NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]> {
  const reply = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  return [
    tool(
      "read_guideline",
      "Read one of the project's guidelines in full, as it is on the base branch (from the <guidelines> list).",
      { path: z.string().describe("The guideline's path, as listed") },
      async ({ path }) => {
        const g = guidelineText(guidelines, path);
        return reply(g ? g.text : `No guideline at ${path} applies to this change.`);
      },
    ),
    tool(
      "file_diff",
      "The diff of one file in this pull request.",
      { path: z.string().describe("The file's path in the repo") },
      async ({ path }) => reply(fileDiff(text, path).slice(0, 60_000) || `${path} isn't changed by this pull request.`),
    ),
    // Search through fff's warm index of the repo (the one nit's own search uses), in place of
    // Grep and Glob: no process per search, recently used and changed files first.
    tool(
      "grep",
      "Search file contents. Search one bare identifier or literal (`getOnshapeOAuthConfig`), not code syntax or a regex spanning tokens. Constraints go first, space-separated: `*.ts`, `*.{ts,tsx}`, a directory like `packages/ee/`, or an exclusion like `!test/`. Results are by file, definitions marked [def]. After two searches, Read the best file instead of searching again.",
      {
        query: z.string().describe("Optional constraints, then the text: `packages/ee/ clientId`"),
        regex: z.boolean().optional().describe("Treat the text as a regex; only when you need alternation or anchors"),
      },
      async ({ query, regex }) => reply(await nav.grepForClaude(query, regex ?? false)),
    ),
    tool(
      "multi_grep",
      "Search for any of several literal patterns at once (OR), such as one name's variants: `['clientId', 'client_id', 'CLIENT_ID']`. One call instead of several greps.",
      {
        patterns: z.array(z.string()).min(1).max(12).describe("Literal patterns, any of which may match"),
        constraints: z.string().optional().describe("File constraints: `*.ts`, `src/`, `!test/`"),
      },
      async ({ patterns, constraints }) => reply(await nav.multiGrepForClaude(patterns, constraints)),
    ),
    tool(
      "find_files",
      "Find files by (fuzzy) name or path when you don't have an identifier to grep for: `onshape oauth`, `integration-id.ts`.",
      { query: z.string().describe("Words from the file's name or path") },
      async ({ query }) => reply(await nav.findForClaude(query)),
    ),
  ];
}
github.warm(); // sign in, find the PR and load its threads while the page loads

const preferredPort = Number(process.env.NIT_PORT ?? 40000 + (Number.parseInt(project.slice(0, 4), 16) % 10000));

if (!compiled() && (dev || isStale(uiDir)))
  await term.task(
    "Building the page",
    () => buildUI(uiDir),
    () => "Built the page",
  );

/** The saved theme, layout and settings, set before first paint so the page never flashes the default. */
function bootScript() {
  const inline = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
  return `window.nitTheme=${inline(store.setting("theme"))};window.nitLayout=${inline(store.setting("layout"))};window.nitPrefs=${inline(prefsOf(store))};${themeBoot}`;
}

/** The images the diff shows as pictures (ui/ImageDiff.tsx keeps the same list). */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** What every open page hears live, over its WebSocket (/api/live). */
const LIVE = "live";
const publish = (e: AgentEvent) => server?.publish(LIVE, JSON.stringify(e));

/**
 * Preferences and the theme are shared by every nit (one database). When they change, here or in
 * another repo's nit, every open page takes the change without a reload. Another process's write
 * shows up as a new `data_version`, checked once a second; only a real change to these is sent.
 */
const settingsNow = () => ({ prefs: prefsOf(store), theme: store.setting("theme") });
let sentSettings = JSON.stringify(settingsNow());
function pushSettings() {
  const now = settingsNow();
  const key = JSON.stringify(now);
  if (key === sentSettings) return;
  sentSettings = key;
  publish({ type: "settings", ...now });
}
let dataVersion = store.dataVersion();
setInterval(() => {
  const v = store.dataVersion();
  if (v === dataVersion) return;
  dataVersion = v;
  pushSettings();
}, 1000);

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);

let port = 0;

// Only this tab may call the API: blocks DNS rebinding (Host) and cross-site requests (Origin).
function guard(req: Request) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  if (!allowed.includes(host)) return fail(403, "bad host");
  if (origin && !allowed.some((a) => origin === `http://${a}`)) return fail(403, "bad origin");
  if (req.method !== "GET" && !req.headers.get("content-type")?.startsWith("application/json"))
    return fail(415, "expected JSON");
  return null;
}

type Handler<R extends Request> = (req: R) => Response | Promise<Response>;
const guarded =
  <R extends Request>(h: Handler<R>): Handler<R> =>
  (req) =>
    guard(req) ?? h(req);

function validPath(path: string) {
  try {
    git.safePath(root, path);
    return true;
  } catch {
    return false;
  }
}

const validName = (name: string) => /^[\p{L}\p{N}_$]{1,200}$/u.test(name);

function position(q: URLSearchParams): { path: string; side: Side; line: number } | null {
  const path = q.get("path") ?? "";
  const side = q.get("side");
  const line = Number(q.get("line"));
  if (!validPath(path) || (side !== "additions" && side !== "deletions") || !Number.isInteger(line) || line < 1)
    return null;
  return { path, side, line };
}

function parseDraft(v: unknown): Draft | null {
  const d = v as Partial<Draft>;
  const ok =
    typeof d?.id === "string" &&
    /^[\w-]{6,64}$/.test(d.id) &&
    typeof d.path === "string" &&
    validPath(d.path) &&
    (d.side === "additions" || d.side === "deletions") &&
    Number.isInteger(d.start) &&
    Number.isInteger(d.end) &&
    d.start! >= 0 &&
    d.end! >= d.start! &&
    typeof d.body === "string" &&
    (d.suggestion === null || typeof d.suggestion === "string") &&
    Array.isArray(d.anchor) &&
    d.anchor.every((l) => typeof l === "string") &&
    (d.replyTo == null || (typeof d.replyTo === "string" && /^[\w=-]{1,200}$/.test(d.replyTo)));
  if (!ok) return null;
  // The page may only keep or clear a proposal it was given (accepting clears it), never make one:
  // proposals come from the co-reviewer, which checks them first.
  const stored = store.draft(d.id!);
  const proposal = d.proposal && stored?.proposal ? stored.proposal : null;
  const now = Date.now();
  return {
    ...(d as Draft),
    proposal,
    createdAt: Number(d.createdAt) || now,
    updatedAt: now,
  };
}

/**
 * Conversations follow their lines when the file changes (an edit, Claude applying comments): a
 * thread moves to where its lines' text now is, or, when they're gone, becomes outdated. Removed
 * lines live in the merge base, which never changes.
 */
async function placeAsks(): Promise<AskThread[]> {
  const threads = store.asks();
  const files = new Map<string, string[] | null>();
  for (const t of threads) {
    if (t.outdated || t.side !== "additions" || !t.anchor?.length) continue;
    if (!files.has(t.path)) files.set(t.path, (await git.readWorking(root, t.path))?.split("\n") ?? null);
    const lines = files.get(t.path);
    const at = lines ? locateLines(lines, t.anchor, t.start) : null;
    if (at === t.start) continue;
    const moved = at === null ? { ...t, outdated: true } : { ...t, start: at, end: at + t.end - t.start };
    store.saveAsk(moved);
    Object.assign(t, moved);
  }
  return threads;
}

const diffHash = (text: string, path: string) =>
  new Bun.CryptoHasher("sha1").update(fileDiff(text, path)).digest("hex");

/** Viewed files whose diff is unchanged since, and the ones that changed (re-review those). */
function viewedNow(text: string) {
  const viewed: string[] = [];
  const changedSinceViewed: string[] = [];
  for (const v of store.viewed()) {
    // A file marked before hashes were kept stays viewed until it's marked again.
    if (v.hash === null || v.hash === diffHash(text, v.path)) viewed.push(v.path);
    else if (fileDiff(text, v.path)) changedSinceViewed.push(v.path);
  }
  return { viewed, changedSinceViewed };
}

async function applySuggestion(d: Draft) {
  if (d.side !== "additions" || d.suggestion === null) return fail(400, "not a suggestion");
  const text = await git.readWorking(root, d.path);
  if (text === null) return fail(409, "The file no longer exists.");
  const lines = text.split("\n");
  const current = lines.slice(d.start - 1, d.end);
  if (current.join("\n") !== d.anchor.join("\n"))
    return fail(409, "These lines changed since the suggestion was written.");
  lines.splice(d.start - 1, d.end - d.start + 1, ...d.suggestion.split("\n"));
  await Bun.write(git.safePath(root, d.path), lines.join("\n"));
  store.deleteDraft(d.id);
  return json({ ok: true });
}

const serve = (p: number) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: p,
    development: false,
    idleTimeout: 60,
    // A page's live connection: what already happened in the current agent run, then everything
    // as it happens (the agent's events, settings changed elsewhere). Bun pings it to keep it up.
    websocket: {
      open(ws) {
        ws.subscribe(LIVE);
        for (const e of agent.replay()) ws.send(JSON.stringify(e));
      },
      message() {}, // the page only listens
    },
    // Never send stack traces to the page; log them where the user started nit.
    error(e) {
      term.error(e);
      return fail(500, "Something went wrong in nit. Details are in the terminal where it's running.");
    },
    routes: {
      "/api/review": {
        GET: guarded(async (req) => {
          const ignoreSpace = new URL(req.url).searchParams.has("w");
          const [text, spaced] = await Promise.all([patch(), patch(true)]);
          // Files in the patch that drop out of the -w one changed only whitespace.
          const kept = new Set(changedPaths(spaced));
          const formatting = changedPaths(text).filter((p) => !kept.has(p));
          const categories = await categorize(root, changedPaths(text));
          for (const p of formatting) categories[p] = "formatting";
          const data: ReviewData = {
            repo: root,
            branch,
            base,
            mergeBase,
            // Read without whitespace changes, but every file is still listed (to hide or show).
            patch: ignoreSpace ? spaced + formatting.map((p) => fileDiff(text, p)).join("") : text,
            categories,
            drafts: store.drafts(),
            ...viewedNow(text),
            asks: await placeAsks(),
            guide: (() => {
              const saved = store.setting(guideKey) as GuideChapter[] | null;
              return saved ? placeGuide(saved, changedPaths(text)) : null;
            })(),
          };
          return json(data);
        }),
      },
      "/api/viewed-text": {
        // A file as it was when marked viewed, for "since you viewed".
        GET: guarded(async (req) => {
          const path = new URL(req.url).searchParams.get("path") ?? "";
          if (!validPath(path)) return fail(400, "invalid path");
          return json({ text: store.viewedText(path) });
        }),
      },
      "/api/file": {
        GET: guarded(async (req) => {
          const url = new URL(req.url);
          const path = url.searchParams.get("path") ?? "";
          const prev = url.searchParams.get("prev") || path;
          try {
            const data: FileContents = {
              old: await git.readAtRef(root, mergeBase, prev),
              new: await git.readWorking(root, path),
            };
            return json(data);
          } catch (e) {
            return fail(400, String(e));
          }
        }),
      },
      "/api/image": {
        // An image's bytes on one side of the diff: the base (old) or the working tree (new).
        GET: guarded(async (req) => {
          const q = new URL(req.url).searchParams;
          const path = q.get("path") ?? "";
          const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
          if (!validPath(path) || !type) return fail(400, "not an image in this repo");
          const file = Bun.file(git.safePath(root, path));
          const old = q.get("side") === "old" ? await git.bytesAtRef(root, mergeBase, path) : null;
          const body = old
            ? new Blob([new Uint8Array(old)])
            : q.get("side") !== "old" && (await file.exists())
              ? file
              : null;
          if (!body) return fail(404, "not on that side");
          return new Response(body, {
            headers: {
              "content-type": type,
              // An SVG opened on its own must not run script in nit's origin.
              "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              "x-content-type-options": "nosniff",
              "cache-control": "no-cache",
            },
          });
        }),
      },
      "/api/drafts": {
        PUT: guarded(async (req) => {
          const d = parseDraft(await req.json().catch(() => null));
          if (!d) return fail(400, "invalid draft");
          store.saveDraft(d);
          return json(d);
        }),
      },
      "/api/drafts/:id": {
        DELETE: guarded((req) => {
          store.deleteDraft(req.params.id);
          return json({ ok: true });
        }),
      },
      "/api/drafts/:id/apply": {
        POST: guarded(async (req) => {
          const d = store.draft(req.params.id);
          return d ? applySuggestion(d) : fail(404, "draft not found");
        }),
      },
      // The same script for a page nit doesn't serve itself: Vite's dev server (vite.config.ts).
      "/api/boot.js": {
        GET: guarded(() => new Response(bootScript(), { headers: { "content-type": "text/javascript" } })),
      },
      "/api/symbols": {
        GET: guarded(async (req) => {
          const q = new URL(req.url).searchParams;
          const path = q.get("path") ?? "";
          if (!validPath(path)) return fail(400, "invalid path");
          const prev = q.get("prev");
          return json(await nav.symbols(path, prev && validPath(prev) ? prev : null, q.get("old") !== "0"));
        }),
      },
      "/api/identifiers": {
        GET: guarded(async (req) => {
          const q = new URL(req.url).searchParams;
          const at = position(q);
          if (!at) return fail(400, "invalid position");
          return json(await nav.identifiers(at.path, at.side, at.line));
        }),
      },
      "/api/definition": {
        GET: guarded(async (req) => {
          const q = new URL(req.url).searchParams;
          const at = position(q);
          if (!at) return fail(400, "invalid position");
          // A name, or a column to read the identifier from (⌘-click on a token).
          const col = Number(q.get("col"));
          const name =
            q.get("name") ??
            (Number.isInteger(col) && col >= 0 ? await nav.identifierAt(at.path, at.side, at.line, col) : null);
          if (!name || !validName(name)) return json({ name: null, results: [] });
          return json({ name, results: await nav.definition(name, at) });
        }),
      },
      "/api/references": {
        GET: guarded(async (req) => {
          const name = new URL(req.url).searchParams.get("name") ?? "";
          if (!validName(name)) return fail(400, "invalid name");
          return json({ name, ...(await nav.references(name)) });
        }),
      },
      "/api/search": {
        GET: guarded(async (req) => {
          const p = new URL(req.url).searchParams;
          const q = p.get("q") ?? "";
          if (!q.trim() || q.length > 500) return json({ matches: [], truncated: false, next: null });
          const after = p.get("after") ?? undefined;
          if (after && after.length > 200) return fail(400, "invalid cursor");
          return json(nav.search(q, { regex: p.get("regex") === "1", caseSensitive: p.get("case") === "1", after }));
        }),
      },
      "/api/linear": {
        GET: guarded(async () => {
          const gh = await github.state();
          const pr = gh.status === "ready" ? gh : null;
          return json(await linearLink(linearRef(branch, pr?.pr.title, pr?.body)));
        }),
      },
      "/api/settings/linear-key": {
        GET: guarded(async () => json({ hasKey: !!(await savedLinearKey()) })),
        PUT: guarded(async (req) => {
          const key = ((await req.json().catch(() => null)) as { key?: unknown } | null)?.key;
          if (key !== null && (typeof key !== "string" || !/^lin_api_\w{20,}$/.test(key.trim())))
            return fail(400, "That isn't a Linear API key (they start with lin_api_).");
          try {
            await saveLinearKey(key === null ? null : key.trim());
            return json({ hasKey: key !== null });
          } catch (e) {
            return fail(500, `Couldn't reach your keychain: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      },
      "/api/github": {
        GET: guarded(async (req) => json(await github.state(new URL(req.url).searchParams.has("fresh")))),
      },
      "/api/github/review": {
        POST: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as {
            event?: unknown;
            summary?: unknown;
            ids?: unknown;
          } | null;
          const events: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];
          if (!body || !events.includes(body.event as ReviewEvent)) return fail(400, "invalid review");
          const ids = Array.isArray(body.ids)
            ? new Set(body.ids.filter((i): i is string => typeof i === "string"))
            : null;
          const drafts = store
            .drafts()
            // Claude's proposals stay local until the reviewer accepts them.
            .filter((d) => !d.proposal && (d.body.trim() || d.suggestion !== null) && (!ids || ids.has(d.id)));
          try {
            const result = await github.postReview(drafts, body.event as ReviewEvent, String(body.summary ?? ""));
            for (const id of result.posted) store.deleteDraft(id);
            term.log(
              `${term.c.green("✓")} posted to GitHub: ${result.posted.length} ${result.posted.length === 1 ? "comment" : "comments"}`,
            );
            return json(result);
          } catch (e) {
            term.log(`${term.c.red("✕")} GitHub didn't take the review: ${e instanceof Error ? e.message : String(e)}`);
            return fail(502, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/github/threads/:id/resolve": {
        POST: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as { resolved?: unknown } | null;
          if (typeof body?.resolved !== "boolean" || !/^[\w=-]{1,200}$/.test(req.params.id))
            return fail(400, "invalid request");
          try {
            await github.setResolved(req.params.id, body.resolved);
            return json({ ok: true });
          } catch (e) {
            return fail(502, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/agent": {
        GET: guarded(async () => json({ run: agent.state() })),
      },
      "/api/auth": {
        GET: guarded(async () => json(await authStatus())),
      },
      "/api/agent/apply": {
        POST: guarded(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
          const ids = Array.isArray(body.ids) ? new Set(body.ids.filter((x) => typeof x === "string")) : null;
          // Replies to GitHub threads are conversation, not code.
          const drafts = store
            .drafts()
            .filter(
              (d) => !d.replyTo && !d.proposal && (d.body.trim() || d.suggestion !== null) && (!ids || ids.has(d.id)),
            );
          if (!drafts.length) return fail(400, "no comments to apply");
          try {
            // The project's rules for the files being changed, from the base branch.
            const guidelines = await loadGuidelines(root, base, [...new Set(drafts.map((d) => d.path))]);
            const text = await patch();
            return json({
              run: await agent.start(drafts, {
                guidelines: guidelinesBlock(guidelines),
                tools: claudeTools(guidelines, text),
              }),
            });
          } catch (e) {
            return fail(409, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/agent/job": {
        GET: guarded(async () => json({ job: agent.job() })),
      },
      "/api/guide": {
        // Claude arranges the files into chapters to read in order.
        POST: guarded(async () => {
          const text = await patch();
          if (!text.trim()) return fail(400, "nothing to review");
          const gh = await github.state();
          const pr = gh.status === "ready" ? gh : null;
          const none: Guidelines = { inline: [], indexed: [], ref: base };
          try {
            const job = await agent.runJob("guide", {
              prompt: guidePrompt({
                patch: text,
                title: pr?.pr.title ?? null,
                body: pr?.body ?? null,
                maxInline: 80_000,
              }),
              instructions: GUIDE_INSTRUCTIONS,
              guidelines: none,
              tools: claudeTools(none, text).filter((t) => t.name === "file_diff"),
              outputFormat: GUIDE_SCHEMA,
              finish: async (out) => {
                const chapters = (out as { chapters?: GuideChapter[] } | undefined)?.chapters;
                if (!chapters?.length) throw new Error("AI didn't return a reading order.");
                store.setSetting(guideKey, placeGuide(chapters, changedPaths(text)));
              },
            });
            return json({ job });
          } catch (e) {
            return fail(409, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/coreview": {
        // Claude reviews the whole diff; what survives nit's checks becomes proposed drafts.
        POST: guarded(async () => {
          const text = await patch();
          if (!text.trim()) return fail(400, "nothing to review");
          const changed = changedPaths(text);
          const guidelines = await loadGuidelines(root, base, changed);
          const gh = await github.state();
          try {
            const job = await agent.runJob("review", {
              prompt: reviewPrompt({
                patch: text,
                title: gh.status === "ready" ? gh.pr.title : null,
                guidelines,
                maxInline: 120_000,
                nits: prefsOf(store).nits,
              }),
              instructions: REVIEW_INSTRUCTIONS,
              guidelines,
              tools: claudeTools(guidelines, text),
              outputFormat: FINDINGS_SCHEMA,
              finish: async (out, j) => {
                const result = out as { findings?: Finding[]; summary?: string } | undefined;
                const { drafts, dropped } = await proposals(result?.findings ?? [], {
                  patch: text,
                  guidelines,
                  existing: store.drafts(),
                  files: (await $`git ls-files`.cwd(root).quiet().text()).split("\n"),
                  maxNits: prefsOf(store).nits ? 2 : 0,
                  text: (side, path) =>
                    side === "additions" ? git.readWorking(root, path) : git.readAtRef(root, mergeBase, path),
                });
                for (const d of drafts) store.saveDraft(d);
                j.found = drafts.length;
                j.dropped = dropped;
                j.summary = result?.summary?.trim() || null;
              },
            });
            return json({ job });
          } catch (e) {
            return fail(409, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/ask": {
        // A question about lines, answered in place; `followUp` continues the last answer's session.
        POST: guarded(async (req) => {
          const b = (await req.json().catch(() => null)) as {
            path?: unknown;
            side?: unknown;
            start?: unknown;
            end?: unknown;
            question?: unknown;
            followUp?: unknown;
          } | null;
          const side = b?.side === "deletions" ? "deletions" : "additions";
          const start = Number(b?.start);
          const end = Number(b?.end);
          if (
            typeof b?.path !== "string" ||
            !validPath(b.path) ||
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 1 ||
            end < start ||
            typeof b.question !== "string" ||
            !b.question.trim() ||
            b.question.length > 4000
          )
            return fail(400, "invalid question");
          const text =
            side === "additions" ? await git.readWorking(root, b.path) : await git.readAtRef(root, mergeBase, b.path);
          if (text === null) return fail(404, "file not found");
          const whole = await patch();
          const guidelines = await loadGuidelines(root, base, [b.path]);
          const at = { path: b.path, side, start, end } as const;
          const selected = text.split("\n").slice(start - 1, end);
          try {
            const job = await agent.runJob("ask", {
              prompt: askPrompt({
                question: b.question,
                ...at,
                lines: selected,
                fileDiff: fileDiff(whole, b.path),
                guidelines,
              }),
              instructions: ASK_INSTRUCTIONS,
              guidelines,
              tools: claudeTools(guidelines, whole),
              at,
              question: b.question,
              resume: typeof b.followUp === "string" && /^[\w-]{8,64}$/.test(b.followUp) ? b.followUp : null,
              // Kept with the lines' conversation, so it can be read again later in the review.
              finish: async (_, j) => {
                if (!j.answer.trim()) return;
                // An outdated conversation isn't continued: these lines start a new one.
                const same = (t: AskThread) =>
                  !t.outdated && t.path === at.path && t.side === at.side && t.start === at.start && t.end === at.end;
                const t: AskThread = store.asks().find(same) ?? {
                  id: crypto.randomUUID(),
                  ...at,
                  turns: [],
                  sessionId: null,
                  updatedAt: 0,
                  anchor: selected,
                };
                const now = Date.now();
                store.saveAsk({
                  ...t,
                  turns: [...t.turns, { question: b.question as string, answer: j.answer.trim(), at: now }],
                  sessionId: j.sessionId ?? t.sessionId,
                  updatedAt: now,
                });
              },
            });
            return json({ job });
          } catch (e) {
            return fail(409, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/asks": {
        GET: guarded(async () => json(await placeAsks())),
      },
      "/api/asks/:id": {
        DELETE: guarded((req) => {
          store.deleteAsk(req.params.id);
          return json({ ok: true });
        }),
      },
      "/api/agent/stop": {
        POST: guarded(async () => {
          agent.stop();
          return json({ ok: true });
        }),
      },
      "/api/agent/undo": {
        POST: guarded(async () => {
          try {
            return json(await agent.undo());
          } catch (e) {
            return fail(409, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/agent/changes": {
        GET: guarded(async () => new Response(await agent.changes(), { headers: { "content-type": "text/plain" } })),
      },
      // The page's live connection: the agent's events and settings saved elsewhere (websocket below).
      "/api/live": (req, srv) => guard(req) ?? (srv.upgrade(req) ? undefined : fail(400, "expected a WebSocket")),
      "/api/settings/prefs": {
        PUT: guarded(async (req) => {
          const patch = PrefsPatch.safeParse(await req.json().catch(() => null));
          if (!patch.success) return fail(400, "invalid preferences");
          const prefs = { ...prefsOf(store), ...patch.data };
          store.setSetting("prefs", prefs);
          pushSettings();
          return json(prefs);
        }),
      },
      "/api/auth/codex": {
        GET: guarded(async () => json(await codexStatus())),
      },
      "/api/settings/codex-key": {
        PUT: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
          const key = body?.key;
          if (key !== null && (typeof key !== "string" || !/^sk-[\w-]{20,}$/.test(key.trim())))
            return fail(400, "That isn't an OpenAI API key (they start with sk-).");
          try {
            await saveCodexKey(key === null ? null : key.trim());
            return json({ hasKey: key !== null });
          } catch (e) {
            return fail(500, `Couldn't reach your keychain: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      },
      // nit's tools for a Codex run (mcp-http.ts): the token in the path is the run's.
      "/mcp/:token": async (req) => {
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.get("host") ?? ""))
          return fail(403, "bad host");
        return handleTools(req, req.params.token);
      },
      "/api/settings/claude-key": {
        PUT: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
          const key = body?.key;
          if (key !== null && (typeof key !== "string" || !/^sk-ant-[\w-]{20,}$/.test(key.trim())))
            return fail(400, "That isn't an Anthropic API key (they start with sk-ant-).");
          try {
            await saveKey(key === null ? null : key.trim());
            return json({ hasKey: key !== null });
          } catch (e) {
            return fail(500, `Couldn't reach your keychain: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      },
      "/api/settings/github": {
        GET: guarded(async () => {
          const remote = parseRemote((await $`git remote get-url origin`.cwd(root).nothrow().quiet().text()).trim());
          return json(remote ? await githubAccount(remote.host) : null);
        }),
        PUT: guarded(async (req) => {
          const remote = parseRemote((await $`git remote get-url origin`.cwd(root).nothrow().quiet().text()).trim());
          if (!remote) return fail(400, "This repo has no origin remote on GitHub.");
          const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
          const t = body?.token;
          if (t !== null && (typeof t !== "string" || !/^(ghp_|github_pat_|gho_|ghu_)[\w]{20,}$/.test(t.trim())))
            return fail(400, "That isn't a GitHub token (they start with ghp_ or github_pat_).");
          try {
            await saveToken(remote.host, t === null ? null : t.trim());
          } catch (e) {
            return fail(500, `Couldn't reach your keychain: ${e instanceof Error ? e.message : String(e)}`);
          }
          github.reconnect();
          return json(await githubAccount(remote.host));
        }),
      },
      "/api/settings/commands": {
        GET: guarded(async () => json(await commandSettings(root))),
        PUT: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          const patch: Partial<Record<"checkout" | "editor", string | null>> = {};
          for (const k of ["checkout", "editor"] as const)
            if (body && k in body) {
              const v = body[k];
              if (v !== null && (typeof v !== "string" || v.length > 2000)) return fail(400, `invalid ${k}`);
              patch[k] = v;
            }
          try {
            await saveUserCommands(patch);
            return json(await commandSettings(root));
          } catch (e) {
            return fail(400, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/open-in-editor": {
        POST: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as { path?: unknown; line?: unknown } | null;
          if (typeof body?.path !== "string" || !validPath(body.path)) return fail(400, "invalid path");
          const line = Number.isInteger(body.line) && (body.line as number) > 0 ? (body.line as number) : 1;
          try {
            return json({ ran: await openInEditor(root, git.safePath(root, body.path), line) });
          } catch (e) {
            return fail(500, e instanceof Error ? e.message : String(e));
          }
        }),
      },
      "/api/settings": {
        PUT: guarded(async (req) => {
          // User settings shared by every review: the theme and the panel layout.
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          const keys = ["theme", "layout"].filter((k) => body && k in body);
          if (!body || !keys.length || keys.some((k) => typeof body[k] !== "object" || body[k] === null))
            return fail(400, "invalid body");
          if (JSON.stringify(body).length > 64_000) return fail(413, "too large");
          for (const k of keys) store.setSetting(k, body[k]);
          pushSettings();
          return json({ ok: true });
        }),
      },
      "/api/viewed": {
        POST: guarded(async (req) => {
          const body = (await req.json().catch(() => null)) as {
            path?: unknown;
            viewed?: unknown;
          } | null;
          if (typeof body?.path !== "string" || typeof body.viewed !== "boolean") return fail(400, "invalid body");
          if (!body.viewed) {
            store.setViewed(body.path, false);
            return json({ ok: true });
          }
          // Remember what was seen: the file's diff (to notice a change) and its text (to show it).
          const content = validPath(body.path) ? await git.readWorking(root, body.path) : null;
          store.setViewed(
            body.path,
            true,
            diffHash(await patch(), body.path),
            content !== null && content.length <= 2_000_000 ? content : null,
          );
          return json({ ok: true });
        }),
      },
    },
    fetch: guarded(async (req) => {
      const path = new URL(req.url).pathname;
      if (dev && path === "/" && isStale(uiDir)) await buildUI(uiDir);
      if (path === "/") {
        const html = await uiFile("/index.html").text();
        return new Response(html.replace("</head>", `<script>${bootScript()}</script></head>`), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const file = uiFile(path);
      if (path.includes("..") || !(await file.exists())) return fail(404, "not found");
      // Vite's assets carry a content hash: the browser can keep them for good.
      return new Response(file, {
        headers: path.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : {},
      });
    }),
  });

let server: ReturnType<typeof serve>;
try {
  server = serve(preferredPort);
} catch {
  server = serve(0); // taken, most likely by another review of the same repo
}
port = server.port!;
agent.subscribe(publish);
setToolBase(`http://127.0.0.1:${port}`);

const url = `http://127.0.0.1:${server.port}`;
const openBrowser = () => Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]);
// Counts for the banner, straight from the patch the page shows.
// What the banner and steps call them: a pull request's own branch and base, not nit's local names.
const shownBranch = opened?.head ?? branch;
const shownBase = opened?.baseName ?? base;
const text = await term.task(
  `Reading the diff against ${shownBase}`,
  () => patch(),
  (t) => {
    const n = t.match(/^diff --git /gm)?.length ?? 0;
    return n
      ? `${n} ${n === 1 ? "file" : "files"} changed against ${shownBase}`
      : `No changes against ${shownBase} yet`;
  },
);
const files = text.match(/^diff --git /gm)?.length ?? 0;
const add = text.match(/^\+(?!\+\+ )/gm)?.length ?? 0;
const del = text.match(/^-(?!-- )/gm)?.length ?? 0;
term.banner({
  title: opened?.title ?? null,
  pr: opened?.number ?? null,
  branch: shownBranch,
  base: shownBase,
  files,
  add,
  del,
  url,
  root,
});
started = true;
self.registerRunning({ url, repo: basename(root), branch: shownBranch });
term.keys({ o: { label: "open", run: openBrowser }, q: { label: "quit", run: () => process.exit(0) } });
if (process.env.NIT_NO_OPEN !== "1") openBrowser();

// A newer nit, checked at most once a day.
void self.updateNotice().then((v) => {
  if (v) term.log(`${term.c.cyan("↑")} nit ${v} is out ${term.c.dim(`(you have ${VERSION}) · run nit update`)}`);
});
// Say up front what won't work, rather than only in the page: GitHub and Claude sign-in.
void github.state().then((gh) => {
  if (gh.status === "ready") {
    const threads = gh.threads.filter((t) => !t.resolved).length;
    term.log(
      `${term.c.green("✓")} GitHub  PR #${gh.pr.number}${threads ? term.c.dim(` · ${threads} open ${threads === 1 ? "thread" : "threads"}`) : ""}`,
    );
  } else if (/no open pull request/i.test(gh.reason))
    term.log(term.c.dim(`· ${gh.reason} Comments stay local until there is one.`));
  else term.log(`${term.c.yellow("!")} GitHub: ${gh.reason}`);
});
void (prefsOf(store).reviewer === "codex" ? codexStatus() : Promise.resolve(null)).then((c) => {
  if (!c) return;
  if (!c.installed)
    term.log(`${term.c.yellow("!")} Codex isn't installed, so Codex features are off.`, [
      term.c.dim("Install it: npm i -g @openai/codex (or brew install codex)."),
    ]);
  else if (!c.loggedIn && !c.hasKey)
    term.log(`${term.c.yellow("!")} Codex isn't signed in, so Codex features are off.`, [
      term.c.dim("Run `codex login`. Or save an OpenAI API key in Settings → AI."),
    ]);
});
void (prefsOf(store).reviewer === "codex" ? Promise.resolve(null) : authStatus()).then((a) => {
  if (!a) return;
  if (!a.installed)
    term.log(`${term.c.yellow("!")} Claude Code isn't installed, so Claude features are off.`, [
      term.c.dim("Install it from https://claude.com/claude-code"),
    ]);
  else if (!a.loggedIn && !a.hasKey)
    term.log(`${term.c.yellow("!")} Claude isn't signed in, so Claude features are off.`, [
      term.c.dim("Run `claude`, then /login. Or save an API key in Settings → AI."),
    ]);
});
