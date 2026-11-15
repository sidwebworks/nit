import { expect, test } from "bun:test";
import type { FileDiffMetadata } from "@pierre/diffs";
import { prepareFileTreeInput } from "@pierre/trees";
import { rows, treeOrder } from "./lines";

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

test("treeOrder agrees with the sidebar tree's own sort, which rejects presorted input it disagrees with", () => {
  // These crashed the tree: "Builder input must be sorted before appendPaths()".
  const paths = [
    "apps/cell/src/App.tsx",
    "apps/cell/src/Floor.tsx",
    "apps/cell/src/Floor3D.tsx",
    "apps/cell/src/floor-data.ts",
    "apps/cell/src/env.d.ts",
    "apps/cell/src/plan.worker.ts",
    "README.md",
    "readme.md",
    "a_b.ts",
    "a-b.ts",
    "aB.ts",
    "a10.ts",
    "a2.ts",
    "a02.ts",
    "x/Ab/1.ts",
    "x/ab/2.ts",
    "x/a.b/3.ts",
  ];
  expect(paths.toSorted(treeOrder)).toEqual([...prepareFileTreeInput(paths).paths]);
});
