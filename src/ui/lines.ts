import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side } from "../types";

/** A line the cursor can stop on. `changed` is false for unchanged context lines. */
export type Row = { side: Side; line: number; changeStart: boolean; changed: boolean };

/**
 * Every line the cursor can stop on, in reading order: context and additions by new line,
 * deletions by old line. With `full`, the unchanged lines between hunks are included too (the
 * file must carry its full text, i.e. not be partial).
 */
export function rows(file: FileDiffMetadata, full = false): Row[] {
  const out: Row[] = [];
  const fill = full && !file.isPartial;
  const context = (from: number, to: number) => {
    for (let l = from; l <= to; l++) out.push({ side: "additions", line: l, changeStart: false, changed: false });
  };
  let nextNew = 1;
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    if (fill) context(nextNew, hunk.additionStart - 1);
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        for (let i = 0; i < part.lines; i++)
          out.push({ side: "additions", line: newLine++, changeStart: false, changed: false });
        oldLine += part.lines;
        continue;
      }
      for (let i = 0; i < part.deletions; i++)
        out.push({ side: "deletions", line: oldLine++, changeStart: i === 0, changed: true });
      for (let i = 0; i < part.additions; i++)
        out.push({ side: "additions", line: newLine++, changeStart: i === 0 && part.deletions === 0, changed: true });
    }
    nextNew = newLine;
  }
  if (fill) context(nextNew, file.additionLines.length);
  return out;
}

/** Line numbers changed on each side of a file: added lines (new) and removed lines (old). */
export function changedLines(file: FileDiffMetadata) {
  const added = new Set<number>();
  const removed = new Set<number>();
  for (const r of rows(file)) if (r.changed) (r.side === "additions" ? added : removed).add(r.line);
  return { added, removed };
}

export function stats(file: FileDiffMetadata) {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

/**
 * File tree order: folders before files at each level, then by name. The sidebar tree
 * (@pierre/trees, `presorted: true`) checks its input against its own default sort and throws
 * "Builder input must be sorted" on any disagreement, so this mirrors that sort exactly:
 * lowercase, digit runs compared as numbers, other text by code unit (not locale), ties broken
 * by the raw name.
 */
export function treeOrder(a: string, b: string) {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xDir = i < x.length - 1;
    const yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return compareNames(x[i], y[i]);
  }
  return x.length - y.length;
}

function compareNames(a: string, b: string) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const xt = naturalTokens(x);
  const yt = naturalTokens(y);
  if (!(xt.length === 1 && yt.length === 1 && typeof xt[0] === "string" && typeof yt[0] === "string")) {
    for (let i = 0; i < Math.min(xt.length, yt.length); i++) {
      const p = xt[i];
      const q = yt[i];
      if (p === q) continue;
      if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
      if (String(p) !== String(q)) return String(p) < String(q) ? -1 : 1;
    }
    if (xt.length !== yt.length) return xt.length < yt.length ? -1 : 1;
  }
  if (x !== y) return x < y ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** "a10b" -> ["a", 10, "b"]: text and digit runs, as the tree splits names. */
function naturalTokens(s: string) {
  const tokens: (string | number)[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && !isDigit(s.charCodeAt(i))) i++;
    if (i >= s.length) break;
    if (i > start) tokens.push(s.slice(start, i));
    let n = 0;
    while (i < s.length && isDigit(s.charCodeAt(i))) n = n * 10 + (s.charCodeAt(i++) - 48);
    tokens.push(n);
    start = i;
  }
  if (start < s.length || tokens.length === 0) tokens.push(s.slice(start));
  return tokens;
}

const isDigit = (c: number) => c >= 48 && c <= 57;
