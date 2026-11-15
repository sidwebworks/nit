import { expect, test } from "bun:test";
import type { FileDiffMetadata } from "@pierre/diffs";
import { firstInRange, rows, treeOrder } from "./lines";

test("rows walk context, deletions then additions with the right line numbers", () => {
  const file = {
    hunks: [
      {
        deletionStart: 1,
        additionStart: 1,
        hunkContent: [
          { type: "context", lines: 2 },
          { type: "change", deletions: 1, additions: 2 },
          { type: "context", lines: 1 },
        ],
      },
    ],
  } as unknown as FileDiffMetadata;
  const got = rows(file).map((r) => `${r.side[0]}${r.line}${r.changeStart ? "*" : ""}`);
  expect(got).toEqual(["a1", "a2", "d3*", "a3", "a4", "a5"]);
});

test("full rows fill the unchanged lines around hunks", () => {
  const file = {
    isPartial: false,
    additionLines: Array.from({ length: 8 }, (_, i) => `l${i + 1}`),
    hunks: [{ deletionStart: 3, additionStart: 3, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }],
  } as unknown as FileDiffMetadata;
  const got = rows(file, true).map((r) => `${r.side[0]}${r.line}`);
  expect(got).toEqual(["a1", "a2", "d3", "a3", "a4", "a5", "a6", "a7", "a8"]);
  expect(rows(file).map((r) => `${r.side[0]}${r.line}`)).toEqual(["d3", "a3"]);
});

test("a changed symbol jumps to its edit inside the span", () => {
  const edits = [5329, 25501, 25513, 25525, 31411];
  expect(firstInRange(edits, 25333, 30000)).toBe(25501);
  expect(firstInRange(edits, 30122, 34000)).toBe(31411);
  expect(firstInRange(edits, 25502, 25512)).toBeUndefined();
});

test("treeOrder puts folders first at each level, keeping folders together", () => {
  const paths = [
    "b.ts",
    "src/z.ts",
    "a.md",
    "src/lib/x.ts",
    "src/a.ts",
    "docs/readme.md",
    "src/lib/a10.ts",
    "src/lib/a2.ts",
  ];
  expect(paths.toSorted(treeOrder)).toEqual([
    "docs/readme.md",
    "src/lib/a2.ts",
    "src/lib/a10.ts",
    "src/lib/x.ts",
    "src/a.ts",
    "src/z.ts",
    "a.md",
    "b.ts",
  ]);
});
