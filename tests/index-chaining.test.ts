import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "./helpers";

describe("index chaining", () => {
  it("chains multiple rules for the same SyntaxKind", () => {
    const code = `
      declare const val: number;
      const x = Math.floor(val);
      /** @inline */
      function f() { return 1; }
      const y = f();
    `;
    const options = {
      pluginOptions: {
        rules: {
          "math-intrinsics": true,
          inline: true,
        },
      },
    };
    const lua = normalizeLua(compile(code, options));
    // math-intrinsics should transform Math.floor
    expect(lua).toContain("val - val % 1");
    // inline should transform f()
    expect(lua).toContain("y = 1");
  });
});
