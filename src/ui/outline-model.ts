import type { Side, Symbol as Sym } from "../types";
import { firstInRange } from "./lines";

export type Entry = Sym & {
  depth: number;
  status: "added" | "changed" | null;
  changedTarget?: { side: Side; line: number };
};

export function jumpTarget(entry: Entry, side: Side, changedView: boolean) {
  return (changedView ? entry.changedTarget : undefined) ?? { side, line: entry.nameLine };
}

type Indexed = { symbol: Sym; depth: number; children: Indexed[] };

function contains(parent: Sym, child: Sym) {
  const startsBefore =
    parent.line < child.line || (parent.line === child.line && (parent.startCol ?? 0) < (child.startCol ?? 0));
  const endsAfter =
    parent.endLine > child.endLine ||
    (parent.endLine === child.endLine && (parent.endCol ?? Infinity) >= (child.endCol ?? Infinity));
  return startsBefore && endsAfter;
}

/** Keep the symbol hierarchy so sibling matching stays within the corresponding parent. */
function indexSymbols(symbols: Sym[]) {
  const stack: Indexed[] = [];
  const roots: Indexed[] = [];
  const all = symbols.map((symbol) => {
    while (stack.length && !contains(stack[stack.length - 1].symbol, symbol)) stack.pop();
    const indexed: Indexed = { symbol, depth: stack.length, children: [] };
    (stack.at(-1)?.children ?? roots).push(indexed);
    stack.push(indexed);
    return indexed;
  });
  return { all, roots };
}

function countBefore(lines: number[], line: number) {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Match both versions of the outline and locate the first edit in each changed symbol. */
export function buildOutline(symbols: Sym[], old: Sym[] | null, added: Set<number>, removed: Set<number>) {
  const current = indexSymbols(symbols);
  const previous = indexSymbols(old ?? []);
  const addedLines = [...added].sort((a, b) => a - b);
  const removedLines = [...removed].sort((a, b) => a - b);
  const matched = new Set<Indexed>();
  const priorFor = new Map<Indexed, Indexed>();
  const matchChildren = (next: Indexed[], before: Indexed[]) => {
    const byName = new Map<string, Indexed[]>();
    for (const item of before) {
      const key = JSON.stringify([item.symbol.kind, item.symbol.name]);
      const siblings = byName.get(key) ?? [];
      siblings.push(item);
      byName.set(key, siblings);
    }
    const nextByName = new Map<string, Indexed[]>();
    for (const item of next) {
      const key = JSON.stringify([item.symbol.kind, item.symbol.name]);
      const siblings = nextByName.get(key) ?? [];
      siblings.push(item);
      nextByName.set(key, siblings);
    }
    for (const [key, siblings] of nextByName) {
      const oldSiblings = byName.get(key) ?? [];
      const stable = new Map<number, Indexed[]>();
      for (const item of oldSiblings) {
        if (removed.has(item.symbol.nameLine)) continue;
        const rank = item.symbol.nameLine - countBefore(removedLines, item.symbol.nameLine);
        const atRank = stable.get(rank) ?? [];
        atRank.push(item);
        stable.set(rank, atRank);
      }
      // Unchanged name lines keep their relative position after discounting edits.
      for (const item of siblings) {
        if (added.has(item.symbol.nameLine)) continue;
        const rank = item.symbol.nameLine - countBefore(addedLines, item.symbol.nameLine);
        const prior = stable.get(rank)?.find((candidate) => !matched.has(candidate));
        if (!prior) continue;
        matched.add(prior);
        priorFor.set(item, prior);
      }
      // Changed name lines are paired with remaining siblings in source order.
      let index = 0;
      for (const item of siblings) {
        if (priorFor.has(item)) continue;
        while (index < oldSiblings.length && matched.has(oldSiblings[index])) index++;
        const prior = oldSiblings[index++];
        if (!prior) continue;
        matched.add(prior);
        priorFor.set(item, prior);
      }
    }
    for (const item of next) matchChildren(item.children, priorFor.get(item)?.children ?? []);
  };
  matchChildren(current.roots, previous.roots);
  const all: Entry[] = current.all.map((item) => {
    const { symbol, depth } = item;
    const prior = priorFor.get(item)?.symbol;
    const addedLine = firstInRange(addedLines, symbol.line, symbol.endLine);
    const removedLine = prior ? firstInRange(removedLines, prior.line, prior.endLine) : undefined;
    const status = old && !prior ? "added" : addedLine !== undefined || removedLine !== undefined ? "changed" : null;
    const changedTarget =
      addedLine !== undefined
        ? { side: "additions" as const, line: addedLine }
        : removedLine !== undefined
          ? { side: "deletions" as const, line: removedLine }
          : undefined;
    return { ...symbol, depth, status, changedTarget };
  });
  return {
    all,
    removed: previous.all.filter((item) => !matched.has(item)).map((item) => item.symbol),
    changedCount: all.filter((item) => item.status).length,
  };
}
