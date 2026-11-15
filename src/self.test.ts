import { expect, test } from "bun:test";
import { newer } from "./self";

test("versions compare as numbers, with or without a v", () => {
  expect(newer("1.10.0", "1.9.2")).toBe(true);
  expect(newer("v1.2.0", "1.1.9")).toBe(true);
  expect(newer("1.1.0", "1.1.0")).toBe(false);
  expect(newer("1.0.9", "1.1.0")).toBe(false);
  expect(newer("2.0", "1.99.99")).toBe(true);
});
