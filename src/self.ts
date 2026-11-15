import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createAuth } from "./auth";
import { codexStatus } from "./codex";
import { userConfigPath } from "./config";
import { compiled, VERSION } from "./embedded";
import { account as githubAccount } from "./github";
import { savedLinearKey } from "./linear";
import { claudeEnv, savedKey } from "./prefs";
import { dataDir } from "./store";
import * as term from "./term";

/**
 * nit looking after itself: whether a newer release is out, `nit status`, `nit update` and
 * `nit uninstall`. It knows how it was installed (Homebrew, the install script, or run from
 * source) and does each the way that install expects.
 */

const REPO = "sidwebworks/nit";
const { c } = term;

// ---------- versions

/** "1.10.0" > "1.9.2": numbers, not text. */
export function newer(a: string, b: string) {
  const x = a.replace(/^v/, "").split(".").map(Number);
  const y = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The latest release's version, from where GitHub redirects /releases/latest: no API limits. */
async function fetchLatest(): Promise<string | null> {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  });
  const tag = r.headers.get("location")?.match(/\/tag\/v?([\d.]+)$/)?.[1];
  return tag ?? null;
}

const CACHE = () => join(dataDir(), "update.json");
const DAY = 24 * 60 * 60 * 1000;

/** The latest version, checked at most once a day (`fresh` asks now). Null when GitHub can't be reached. */
export async function latest(fresh = false): Promise<{ version: string; checkedAt: number } | null> {
  try {
    const cached = JSON.parse(readFileSync(CACHE(), "utf8")) as { version: string; checkedAt: number };
    if (!fresh && Date.now() - cached.checkedAt < DAY) return cached;
  } catch {}
  try {
    const version = await fetchLatest();
    if (!version) return null;
    const entry = { version, checkedAt: Date.now() };
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(CACHE(), JSON.stringify(entry));
    return entry;
  } catch {
    return null;
  }
}

/** On launch: a newer release, if there is one. Quiet when offline, from source, or turned off. */
export async function updateNotice(): Promise<string | null> {
  if (!compiled() || process.env.NIT_NO_UPDATE_CHECK === "1") return null;
  const l = await latest();
  return l && newer(l.version, VERSION) ? l.version : null;
}

// ---------- how nit was installed

type Install = { kind: "brew" | "binary" | "source"; path: string };

function install(): Install {
  if (!compiled()) return { kind: "source", path: process.argv[1] ?? process.cwd() };
  const path = process.execPath;
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  return { kind: real.includes("/Cellar/nit/") ? "brew" : "binary", path };
}

const howInstalled = (i: Install) =>
  i.kind === "brew" ? "Homebrew" : i.kind === "binary" ? "install script" : "from source";

// ---------- running reviews

const RUNNING = () => join(dataDir(), "running");
type Running = { pid: number; url: string; repo: string; branch: string; startedAt: number };

/** This nit is serving a review: `nit status` lists it until it exits. */
export function registerRunning(r: Omit<Running, "pid" | "startedAt">) {
  const file = join(RUNNING(), `${process.pid}.json`);
  try {
    mkdirSync(RUNNING(), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...r, pid: process.pid, startedAt: Date.now() }));
  } catch {
    return;
  }
  const remove = () => rmSync(file, { force: true });
  process.on("exit", remove);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      remove();
      process.exit(0);
    });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Reviews open right now; files left by a nit that crashed are cleared on the way. */
function running(): Running[] {
  let files: string[] = [];
  try {
    files = readdirSync(RUNNING()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Running[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(RUNNING(), f), "utf8")) as Running;
      if (alive(r.pid)) out.push(r);
      else rmSync(join(RUNNING(), f), { force: true });
    } catch {}
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// ---------- output

const dot = (tone: "green" | "yellow" | "red" | "dim") => (tone === "dim" ? c.dim("○") : c[tone]("●"));
const row = (label: string, value: string, detail = "") =>
  console.log(`  ${c.dim(label.padEnd(10))}${value}${detail ? `  ${c.dim(detail)}` : ""}`);
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.round(m / 60)}h ago`
        : `${Math.round(m / 1440)}d ago`;
};

function size(path: string): number {
  let total = 0;
  try {
    const s = statSync(path);
    if (s.isFile()) return s.size;
    for (const f of readdirSync(path)) total += size(join(path, f));
  } catch {}
  return total;
}
const mb = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------- nit status

export async function status() {
  term.header(VERSION);
  const auth = createAuth(
    () => claudeEnv({ auth: "login" }),
    async () => !!(await savedKey()),
  );
  const [update, claude, codex, gh, linear] = await term.task(
    "Checking",
    () =>
      Promise.all([
        compiled() ? latest(true) : Promise.resolve(null),
        auth(),
        codexStatus(),
        githubAccount("github.com").catch(() => null),
        savedLinearKey(),
      ]),
    () => "Checked",
  );
  console.log();

  const i = install();
  if (i.kind === "source") row("Version", `${VERSION} ${c.dim("from source")}`);
  else if (!update) row("Version", VERSION, "couldn't reach GitHub to check for updates");
  else if (newer(update.version, VERSION))
    row("Version", `${VERSION} ${c.yellow(`→ ${update.version} is out`)}`, "run nit update");
  else row("Version", `${VERSION} ${c.green("latest")}`);
  row("Installed", term.tilde(i.path), howInstalled(i));
  const data = dataDir();
  row("Data", term.tilde(data), existsSync(data) ? mb(size(data)) : "nothing yet");
  row("Config", term.tilde(userConfigPath()), existsSync(userConfigPath()) ? "" : "not created yet");
  console.log();

  const ai = (name: string, s: Awaited<ReturnType<typeof codexStatus>>) =>
    !s.installed
      ? `${dot("dim")} ${name} ${c.dim("not installed")}`
      : s.loggedIn
        ? `${dot("green")} ${name}${s.method ? c.dim(` · ${s.method === "claude.ai" ? "Claude subscription" : s.method}`) : ""}`
        : s.hasKey
          ? `${dot("green")} ${name} ${c.dim("· API key")}`
          : `${dot("yellow")} ${name} ${c.dim("not signed in")}`;
  row("AI", ai("Claude Code", claude));
  row("", ai("Codex", codex));
  row(
    "GitHub",
    gh?.login
      ? `${dot("green")} ${gh.login} ${c.dim(gh.source === "nit" ? "· token" : "· GitHub CLI")}`
      : gh?.source
        ? `${dot("red")} ${c.red("sign-in refused")}`
        : `${dot("yellow")} not signed in ${c.dim("· gh auth login")}`,
  );
  row("Linear", linear ? `${dot("green")} key saved` : `${dot("dim")} ${c.dim("no key")}`);
  console.log();

  const open = running();
  if (!open.length) row("Reviews", c.dim("none open"));
  for (const [n, r] of open.entries())
    row(n ? "" : "Reviews", `${c.cyan(r.url)}  ${r.repo} ${c.dim(r.branch)}`, ago(r.startedAt));
  console.log();
}

// ---------- nit update

export async function update() {
  term.header(VERSION);
  const i = install();
  if (i.kind === "source")
    term.fail(
      new term.NitError(
        "This nit runs from source",
        `${term.tilde(i.path)} isn't an installed release.`,
        "Update it with git pull, or install a release: brew install sidwebworks/tap/nit",
      ),
    );
  const l = await term.task(
    "Checking for a newer nit",
    () => latest(true),
    (r) => (r ? `Latest is ${r.version}` : "Checked"),
  );
  if (!l)
    term.fail(
      new term.NitError(
        "Couldn't reach GitHub",
        "nit checks its releases there.",
        "Check your connection and try again.",
      ),
    );
  if (!newer(l.version, VERSION)) {
    console.log(`\n  ${c.green("✓")} nit ${VERSION} is the latest\n`);
    return;
  }
  if (i.kind === "brew") {
    console.log(`  ${c.dim("· through Homebrew")}\n`);
    const p = Bun.spawn(["brew", "upgrade", "sidwebworks/tap/nit"], { stdio: ["inherit", "inherit", "inherit"] });
    if ((await p.exited) !== 0)
      term.fail(
        new term.NitError(
          "Homebrew couldn't upgrade nit",
          undefined,
          "Try it yourself: brew upgrade sidwebworks/tap/nit",
        ),
      );
  } else {
    await term.task(`Installing ${l.version}`, (note) => replaceBinary(i.path, l.version, note));
  }
  console.log(`\n  ${c.green("✓")} Updated nit ${c.dim(VERSION)} → ${c.bold(l.version)}\n`);
}

/** Downloads a release for this machine, checks it against its checksum, and swaps it in. */
async function replaceBinary(path: string, version: string, note: (s: string) => void) {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) throw new term.NitError(`There's no nit build for ${process.platform} ${process.arch}`);
  const asset = `nit-${os}-${arch}.tar.gz`;
  const base = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
  const [tar, sum] = await Promise.all([fetch(base), fetch(`${base}.sha256`)]);
  if (!tar.ok || !sum.ok || !tar.body)
    throw new term.NitError(`Couldn't download nit ${version}`, `${base} answered ${tar.status}.`);
  const bytes = await download(tar, note);
  const want = (await sum.text()).trim().split(/\s+/)[0];
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (want !== got)
    throw new term.NitError(
      "The download didn't match its checksum",
      `Expected ${want}, got ${got}.`,
      "Try again; if it keeps happening, report it.",
    );
  const dir = join(dataDir(), `update-${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, asset), bytes);
    await $`tar -xzf ${join(dir, asset)} -C ${dir}`.quiet();
    // Beside the old binary, then renamed over it: a running nit keeps its copy, and a failed
    // update never leaves half a file where nit was.
    const next = `${path}.new`;
    await $`cp ${join(dir, "nit")} ${next} && chmod +x ${next} && mv -f ${next} ${path}`.quiet();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A download, read as it arrives so the spinner can say how far along it is. A connection that
 * goes quiet for 30 seconds is given up on, rather than left spinning.
 */
async function download(res: Response, note: (s: string) => void): Promise<Uint8Array> {
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new term.NitError(
              "The download stalled",
              "No data arrived for 30 seconds.",
              "Check your connection and run nit update again.",
            ),
          ),
        30_000,
      );
    });
    const chunk = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
    if (chunk.done) break;
    parts.push(chunk.value);
    got += chunk.value.length;
    note(total ? `${mb(got)} of ${mb(total)}` : mb(got));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------- nit uninstall

const SECRETS = ["anthropic-api-key", "openai-api-key", "linear-api-key"];

export async function uninstall(flags: string[]) {
  term.header(VERSION);
  const purge = flags.includes("--purge");
  const yes = flags.includes("--yes") || flags.includes("-y");
  const i = install();
  if (i.kind === "source")
    term.fail(
      new term.NitError(
        "This nit runs from source",
        "There's no installed release to remove.",
        "Delete the checkout to remove it.",
      ),
    );

  const data = dataDir();
  const config = dirname(userConfigPath());
  console.log(`  ${c.bold("This removes")}`);
  console.log(`    ${c.red("−")} ${i.kind === "brew" ? "the Homebrew package nit" : term.tilde(i.path)}`);
  if (purge) {
    if (existsSync(data))
      console.log(
        `    ${c.red("−")} ${term.tilde(data)} ${c.dim(`your reviews, drafts and settings · ${mb(size(data))}`)}`,
      );
    if (existsSync(config)) console.log(`    ${c.red("−")} ${term.tilde(config)} ${c.dim("your config")}`);
    console.log(`    ${c.red("−")} nit's keys in your keychain ${c.dim("API keys and GitHub tokens")}`);
  } else console.log(`  ${c.dim(`Your reviews and settings stay in ${term.tilde(data)}; --purge removes them too.`)}`);
  console.log();

  if (!yes) {
    if (!process.stdin.isTTY)
      term.fail(
        new term.NitError("nit asks before removing itself", undefined, "Run it in a terminal, or pass --yes."),
      );
    if (!confirm(`  ${c.bold("Remove?")}`)) {
      console.log(`  ${c.dim("Nothing removed.")}\n`);
      return;
    }
  }

  if (i.kind === "brew") {
    const p = Bun.spawn(["brew", "uninstall", "nit"], { stdio: ["inherit", "inherit", "inherit"] });
    if ((await p.exited) !== 0)
      term.fail(new term.NitError("Homebrew couldn't remove nit", undefined, "Try: brew uninstall nit"));
  } else rmSync(i.path, { force: true });
  console.log(`  ${c.green("✓")} Removed nit`);

  if (purge) {
    rmSync(data, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
    const hosts = await Bun.secrets.get({ service: "nit", name: "github-token:github.com" }).catch(() => null);
    for (const name of [...SECRETS, ...(hosts ? ["github-token:github.com"] : [])])
      await Bun.secrets.delete({ service: "nit", name }).catch(() => {});
    console.log(`  ${c.green("✓")} Removed your reviews, settings, config and keys`);
  }
  console.log(`\n  ${c.dim("Thanks for trying nit.")}\n`);
}
