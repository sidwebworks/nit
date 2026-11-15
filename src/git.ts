import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { $ } from "bun";
import { NitError } from "./term";

const out = async (p: ReturnType<typeof $>) => (await p.nothrow().quiet().text()).trim();

export async function repoRoot(cwd = process.cwd()) {
  return out($`git rev-parse --show-toplevel`.cwd(cwd));
}

export async function defaultBase(root: string) {
  return (await out($`git symbolic-ref --short refs/remotes/origin/HEAD`.cwd(root))) || "main";
}

const exists = async (root: string, ref: string) =>
  (await $`git rev-parse --verify --quiet ${`${ref}^{commit}`}`.cwd(root).nothrow().quiet()).exitCode === 0;

/**
 * What to diff against: the branch or commit you named (or origin's copy of it), else origin's
 * default branch, else main or master. Throws a NitError saying what's missing.
 */
export async function resolveBase(root: string, named?: string) {
  if (named) {
    if (await exists(root, named)) return named;
    if (await exists(root, `origin/${named}`)) return `origin/${named}`;
    throw new NitError(
      `There's no branch or commit called ${named}`,
      "It isn't here, and origin doesn't have it either.",
      "Fetch it first (`git fetch origin`), or compare against another branch: nit <branch>",
    );
  }
  for (const ref of [await defaultBase(root), "origin/main", "main", "origin/master", "master"])
    if (ref && (await exists(root, ref))) return ref;
  throw new NitError(
    "Couldn't tell which branch to compare against",
    "This repository has no origin default branch, main or master.",
    "Name it: nit <branch>",
  );
}

export async function mergeBase(root: string, base: string) {
  return out($`git merge-base ${base} HEAD`.cwd(root));
}

export async function currentBranch(root: string) {
  const name = await out($`git rev-parse --abbrev-ref HEAD`.cwd(root));
  return name === "HEAD" ? await out($`git rev-parse --short HEAD`.cwd(root)) : name;
}

export type Repo = { host: string; owner: string; name: string };

/**
 * owner/name from an origin URL in any form git accepts: git@host:o/r.git, https://host/o/r,
 * ssh://git@host:port/o/r. GitHub's SSH-over-443 host (ssh.github.com) means github.com.
 */
export function parseRemote(url: string): Repo | null {
  const u = url.trim().replace(/^git\+/, "");
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = u.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (!scp) return null;
    [, host, path] = scp;
  }
  const [owner, name] = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (!owner || !name) return null;
  host = host.toLowerCase();
  return { host: host === "ssh.github.com" ? "github.com" : host, owner, name };
}

/** Same repo across clones and worktrees: the origin's host/owner/name, else the first commit. */
export async function projectId(root: string) {
  const remote = parseRemote(await out($`git remote get-url origin`.cwd(root)));
  const key = remote
    ? `${remote.host}/${remote.owner}/${remote.name}`.toLowerCase()
    : await out($`git rev-list --max-parents=0 HEAD`.cwd(root));
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/**
 * Committed, staged and unstaged changes since the merge base, plus untracked files.
 * `ignoreSpace` leaves out whitespace changes (-w); a file where only whitespace changed drops out.
 */
export async function diff(root: string, base: string, ignoreSpace = false) {
  const w = ignoreSpace ? ["-w"] : [];
  const tracked = await $`git diff --no-color --no-ext-diff -M ${w} ${base}`.cwd(root).quiet().text();
  const untracked = (await $`git ls-files --others --exclude-standard`.cwd(root).quiet().text())
    .split("\n")
    .filter(Boolean);
  // ponytail: one git process per untracked file; batch if agents start dumping hundreds of files
  const added = await Promise.all(
    untracked.map((f) =>
      $`git diff --no-color --no-ext-diff --no-index /dev/null ${f}`.cwd(root).nothrow().quiet().text(),
    ),
  );
  return tracked + added.join("");
}

const realRoots = new Map<string, string>();

/** The real path of `p`, following symlinks through its nearest existing ancestor (new files don't exist yet). */
function realOf(p: string): string {
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), relative(cur, p));
    } catch {
      if (dirname(cur) === cur) return p;
    }
  }
}

const under = (rel: string) => !rel.startsWith("..") && !isAbsolute(rel);

/** True when `path` is `root` or inside it, both as written and once symlinks are followed. */
export function within(root: string, path: string) {
  if (!under(relative(root, resolve(root, path)))) return false;
  const real = realRoots.get(root) ?? realOf(root);
  realRoots.set(root, real);
  return under(relative(real, realOf(resolve(root, path))));
}

/** Resolves a repo-relative path to a file inside the repo, refusing escapes, symlinks included. */
export function safePath(root: string, path: string) {
  if (!relative(root, resolve(root, path)) || !within(root, path)) throw new Error(`path outside repo: ${path}`);
  return resolve(root, path);
}

export async function readAtRef(root: string, ref: string, path: string): Promise<string | null> {
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path outside repo: ${path}`);
  // A commit's files never change: cache reads at a full sha (the session's merge base).
  const key = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(ref) ? `${root}\0${ref}\0${path}` : null;
  const hit = key ? atRef.get(key) : undefined;
  if (hit) return hit;
  const read = $`git show ${`${ref}:${path}`}`
    .cwd(root)
    .nothrow()
    .quiet()
    .then((r) => (r.exitCode === 0 ? r.text() : null));
  if (key) atRef.set(key, read);
  return read;
}

// ponytail: unbounded; one review touches a bounded set of files.
const atRef = new Map<string, Promise<string | null>>();

/** A file's bytes at `ref` (an image, say), or null when it isn't there. */
export async function bytesAtRef(root: string, ref: string, path: string): Promise<Buffer | null> {
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path outside repo: ${path}`);
  const r = await $`git show ${`${ref}:${path}`}`.cwd(root).nothrow().quiet();
  return r.exitCode === 0 ? r.stdout : null;
}

export async function readWorking(root: string, path: string): Promise<string | null> {
  const f = Bun.file(safePath(root, path));
  return (await f.exists()) ? f.text() : null;
}
