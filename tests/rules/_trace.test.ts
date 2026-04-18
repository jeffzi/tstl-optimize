// biome-ignore lint/suspicious/noConsole: debug trace test
import { describe, it } from "vitest";
import { compile } from "../helpers";

describe("trace", () => {
  it("traces", () => {
    const lua = compile(
      "declare const arr: {n:number}; function f() { let called = false; const a = arr; const n = a.n; if (n > 0) { for (let i = n - 1; i >= 0; i--) { called = true; } } return called; }",
    );
    console.log(lua);
  });
});
