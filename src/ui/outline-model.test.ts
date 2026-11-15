import { expect, test } from "bun:test";
import { parse } from "../symbols";
import type { Symbol as Sym } from "../types";
import { buildOutline, jumpTarget } from "./outline-model";

const symbol = (kind: string, name: string, line: number, endLine: number): Sym => ({
  kind,
  name,
  line,
  endLine,
  nameLine: line,
  nameCol: 0,
});

test("same-named methods in different classes keep separate change status", () => {
  const outline = [
    symbol("class", "A", 1, 4),
    symbol("method", "run", 2, 3),
    symbol("class", "B", 6, 9),
    symbol("method", "run", 7, 8),
  ];
  const view = buildOutline(outline, outline, new Set(), new Set([3]));
  expect(view.all.map((entry) => entry.status)).toEqual(["changed", "changed", null, null]);
  expect(view.all[1].changedTarget).toEqual({ side: "deletions", line: 3 });
  expect(view.all[3].changedTarget).toBeUndefined();
});

test("removing one same-named method does not hide it behind another", () => {
  const old = [
    symbol("class", "A", 1, 4),
    symbol("method", "run", 2, 3),
    symbol("class", "B", 6, 9),
    symbol("method", "run", 7, 8),
  ];
  const now = [symbol("class", "B", 1, 4), symbol("method", "run", 2, 3)];
  const view = buildOutline(now, old, new Set(), new Set([1, 2, 3, 4, 5]));
  expect(view.removed.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["class:A", "method:run"]);
  expect(view.all.map((entry) => entry.status)).toEqual([null, null]);
});

test("removing the first of two same-named methods preserves the second", () => {
  const old = [symbol("class", "A", 1, 8), symbol("method", "run", 2, 3), symbol("method", "run", 6, 7)];
  const now = [symbol("class", "A", 1, 6), symbol("method", "run", 4, 5)];
  const view = buildOutline(now, old, new Set(), new Set([2, 3]));
  expect(view.removed).toEqual([old[1]]);
  expect(view.all[1].status).toBeNull();
});

test("children follow the surviving same-named parent", () => {
  const old = [
    symbol("class", "A", 1, 4),
    symbol("method", "first", 2, 3),
    symbol("class", "A", 6, 9),
    symbol("method", "second", 7, 8),
  ];
  const now = [symbol("class", "A", 1, 4), symbol("method", "second", 2, 3)];
  const view = buildOutline(now, old, new Set(), new Set([1, 2, 3, 4, 5]));
  expect(view.removed).toEqual([old[0], old[1]]);
  expect(view.all.map((entry) => entry.status)).toEqual([null, null]);
});

test("same-line classes keep their methods in separate scopes", async () => {
  const old = (await parse("same-line:old", "one.ts", "class A { run() { return 1 } } class B { run() { return 2 } }"))!;
  const now = (await parse("same-line:new", "one.ts", "class B { run() { return 2 } }"))!;
  const view = buildOutline(now.outline, old.outline, new Set([1]), new Set([1]));
  expect(view.removed.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["class:A", "method:run"]);
  expect(view.all.map((entry) => entry.status)).not.toContain("added");
});

test("deletion-only changes target the removed line on the old side", () => {
  const before = [symbol("function", "work", 1, 6)];
  const after = [symbol("function", "work", 1, 5)];
  const view = buildOutline(after, before, new Set(), new Set([4]));
  expect(view.all[0]).toMatchObject({ status: "changed", changedTarget: { side: "deletions", line: 4 } });
  expect(jumpTarget(view.all[0], "additions", true)).toEqual({ side: "deletions", line: 4 });
  expect(jumpTarget(view.all[0], "additions", false)).toEqual({ side: "additions", line: 1 });
});

test("added lines take priority when a symbol has additions and deletions", () => {
  const before = [symbol("function", "work", 1, 6)];
  const after = [symbol("function", "work", 1, 6)];
  const view = buildOutline(after, before, new Set([5]), new Set([4]));
  expect(view.all[0].changedTarget).toEqual({ side: "additions", line: 5 });
});
