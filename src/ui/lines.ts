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

/** In a sorted list of changed lines, find the first one inside a symbol's span. */
export function firstInRange(lines: number[], start: number, end: number) {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return lines[lo] <= end ? lines[lo] : undefined;
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

/** File tree order: folders before files at each level, then by name. Matches the sidebar tree. */
export function treeOrder(a: string, b: string) {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xDir = i < x.length - 1;
    const yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return x[i].localeCompare(y[i], undefined, { numeric: true, sensitivity: "base" });
  }
  return x.length - y.length;
}
