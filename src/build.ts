import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
/** Dev servers (NIT_DEV=1) build apart, so a dev run never swaps the UI under a running nit. */
export const uiDirFor = (dev: boolean) => join(root, dev ? "dist/ui-dev" : "dist/ui");

/** Newest modification time under the UI's sources (the UI and the types it shares). */
function sourcesChanged() {
  let newest = statSync(join(import.meta.dir, "types.ts")).mtimeMs;
  try {
    newest = Math.max(newest, statSync(join(import.meta.dir, "../bun.lock")).mtimeMs); // dependency updates
  } catch {}
  for (const entry of readdirSync(join(import.meta.dir, "ui"), { recursive: true, withFileTypes: true }))
    if (entry.isFile()) newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  return newest;
}

/** The build is missing or older than its sources: a restart after an update rebuilds. */
export function isStale(dir: string) {
  try {
    return statSync(join(dir, "index.html")).mtimeMs < sourcesChanged();
  } catch {
    return true;
  }
}

const building = new Map<string, Promise<void>>();

/** Bundles the browser UI (Vite: React with its compiler, Tailwind) into `dir`. Requests during a build share it. */
export function buildUI(dir: string) {
  let b = building.get(dir);
  if (!b) {
    b = build(dir).finally(() => building.delete(dir));
    building.set(dir, b);
  }
  return b;
}

async function build(dir: string) {
  // Loaded only when building: the single binary carries a built UI and no Vite.
  const { build: vite } = await import("vite");
  await vite({
    configFile: join(root, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: dir, emptyOutDir: true },
  });
}

if (import.meta.main) {
  const dir = uiDirFor(false);
  await buildUI(dir);
  console.log(`built ${dir}`);
}
