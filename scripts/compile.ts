// Builds nit as one executable: `bun scripts/compile.ts [bun-target]`, e.g. bun-darwin-arm64.
// The browser UI and the tree-sitter grammars go inside it; Claude Code doesn't (it's ~300 MB),
// so the binary runs the `claude` on your PATH. Output: dist/release/nit-<os>-<arch>.tar.gz
// (with nit inside) and its .sha256. The name carries no version, so
// releases/latest/download/nit-<os>-<arch>.tar.gz always points at the newest.
//
// Build each target on its own platform (CI does): fff's native library is embedded from the
// optional package installed for the machine running the build.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { $ } from "bun";
import { buildUI } from "../src/build";
import { VERSION } from "../src/embedded";
import { WASM_FILES } from "../src/symbols";

const root = join(import.meta.dir, "..");
const target = process.argv[2] ?? `bun-${process.platform}-${process.arch}`;
const [, os, arch] = target.split("-");
const ui = join(root, "dist/ui");
const out = join(root, "dist/release");

await buildUI(ui);

// The entry bakes every file in as a `type: "file"` import (a path inside the executable),
// records them, then starts nit.
const uiFiles = readdirSync(ui, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith(".map"))
  .map((e) => relative(ui, join(e.parentPath, e.name)));
const wasmDir = join(root, "node_modules/@vscode/tree-sitter-wasm/wasm");
const lines = [
  'import { embedded } from "../src/embedded";',
  ...uiFiles.map((f, i) => `import u${i} from ${JSON.stringify(`./ui/${f}`)} with { type: "file" };`),
  ...WASM_FILES.map((f, i) => `import w${i} from ${JSON.stringify(join(wasmDir, f))} with { type: "file" };`),
  ...uiFiles.map((f, i) => `embedded.ui.set(${JSON.stringify(`/${f}`)}, u${i});`),
  ...WASM_FILES.map((f, i) => `embedded.wasm.set(${JSON.stringify(f)}, w${i});`),
  'await import("../src/cli");',
];
const entry = join(root, "dist/entry.ts");
await Bun.write(entry, `${lines.join("\n")}\n`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "pkg"), { recursive: true });
const bin = join(out, "pkg/nit");
await $`bun build ${entry} --compile --minify --target=${target} --outfile=${bin} --external=vite ${
  os === "linux" ? ["--define", `FFF_LIBC="${process.env.FFF_LIBC ?? "gnu"}"`] : []
}`.cwd(root);

const name = `nit-${os}-${arch}.tar.gz`;
await $`tar -czf ${join(out, name)} -C ${join(out, "pkg")} nit`;
const sum = (await $`shasum -a 256 ${name}`.cwd(out).text()).trim();
await Bun.write(join(out, `${name}.sha256`), `${sum}\n`);
console.log(`nit ${VERSION}: ${name}\n${sum}`);
