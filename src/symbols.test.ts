import { describe, expect, test } from "bun:test";
import { type Grammar, identifierAt, identifiersOnLine, load, parse } from "./symbols";

const ALL: Grammar[] = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "ruby",
  "php",
  "cpp",
];

describe("every vendored tags query compiles against its grammar", () => {
  for (const g of ALL) test(g, async () => expect((await load(g)).query.captureNames.length).toBeGreaterThan(0));
});

const TS = `export function resolveToken(cfg: Config) {
  return cfg.token ?? fallback(cfg);
}

export class Client {
  get(url: string) {
    return fetch(url);
  }
}

interface Config { token?: string }

export type Id = string;
enum Mode { A, B }
export const LIMIT = 10;
const helper = () => 1;
function inner() { const local = 1; return local; }
`;

test("outline lists definitions with kinds and ranges", async () => {
  const p = await parse("t1", "a.ts", TS);
  const got = p!.symbols.map((s) => `${s.kind}:${s.name}@${s.line}-${s.endLine}`);
  expect(got).toContain("function:resolveToken@1-3");
  expect(got).toContain("class:Client@5-9");
  expect(got).toContain("method:get@6-8");
  expect(got).toContain("interface:Config@11-11");
  expect(got).toContain("type:Id@13-13");
  expect(got).toContain("enum:Mode@14-14");
  expect(got).toContain("constant:LIMIT@15-15");
  expect(got).toContain("function:helper@16-16");
  expect(got.some((g) => g.includes(":local@"))).toBe(false);
});

test("identifiers: at a position, and per line", async () => {
  const p = (await parse("t2", "a.ts", TS))!;
  expect(identifierAt(p, 2, 14)).toBe("token"); // cfg.t|oken
  expect(identifierAt(p, 2, 3)).toBeNull(); // inside the `return` keyword
  expect(identifiersOnLine(p, 2).map((i) => i.name)).toEqual(["cfg", "token", "fallback"]);
});

const TEST_FILE = `import { describe, expect, it } from "vitest";

describe("Ramp bill payment confirm items", () => {
  const bill = { id: "bill-a" };
  const payment = (method: string) => ({ id: "batch-pay-1", method });
  const deps = {
    getMappedInvoiceId: async () => null,
  };

  it("keys a card-paid bill by the bill", async () => {
    expect(payment("CARD")).toBeTruthy();
  });

  it.each([1, 2])("handles %i", () => {});
});

export class Store {
  count = 0;
  bump() {
    return ++this.count;
  }
}

export const LIMIT = 10;
export const make = () => new Store();
`;

test("outline: test blocks by name, declarations, no object properties or locals", async () => {
  const p = (await parse("outline-1", "a.test.ts", TEST_FILE))!;
  const got = p.outline.map((s) => `${s.kind}:${s.name}`);
  expect(got).toEqual([
    "suite:Ramp bill payment confirm items",
    "test:keys a card-paid bill by the bill",
    "class:Store",
    "field:count",
    "method:bump",
    "variable:LIMIT",
    "function:make",
  ]);
  // Definitions for navigation still include what the tags query finds (e.g. the property).
  expect(p.symbols.some((s) => s.name === "getMappedInvoiceId")).toBe(true);
});

test("every outline query compiles", async () => {
  for (const g of ["typescript", "tsx", "javascript"] as const) expect((await load(g)).outline).not.toBeNull();
});

test("deferred definitions remain available after their parse tree is evicted", async () => {
  const source = "export function retained() { return 1; }";
  const first = (await parse("evicted:first", "retained.ts", source))!;
  for (let i = 0; i < 201; i++) await parse(`evicted:${i}`, "retained.ts", source);
  expect(first.symbols.map((symbol) => symbol.name)).toContain("retained");
});
