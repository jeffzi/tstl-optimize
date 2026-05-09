import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

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
    expect(lua).toContain("val - val % 1");
    expect(lua).toContain("y = 1");
  });
});

describe("index chaining — SourceFile visitor fallback", () => {
  it("chains statement visitors when two rules both handle ExpressionStatement", () => {
    // conditional-compilation and constant-folding both register for ExpressionStatement.
    // math-intrinsics is active via defaults and produces "val - val % 1", proving
    // the full chain ran without any rule being silenced by another.
    const code = `
      declare const val: number;

      const x = Math.floor(val);
      const doubled = Math.floor(val) + Math.floor(val);
    `;
    const options = {
      pluginOptions: {
        rules: {
          "conditional-compilation": true,
          "constant-folding": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("val - val % 1");
    expect(lua).toContain("doubled =");
  });

  it.each([
    {
      name: "chains statement visitors when multiple rules handle same statement kind",
      code: `
        declare const n: number;

        /** @inline */
        function getValue() { return 1; }

        const x = getValue();
        const y = Math.floor(n);
      `,
      expectedInline: "x = 1",
    },
    {
      name: "applies chained visitors through SourceFile statement fallback with inline",
      code: `
        declare const n: number;

        /** @inline */
        function getValue(): number {
          return 42;
        }

        const x = Math.floor(n);
        const y = getValue();
      `,
      expectedInline: "= 42",
    },
  ])("$name", ({ code, expectedInline }) => {
    const options = {
      pluginOptions: {
        rules: {
          "math-intrinsics": true,
          inline: true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("n - n % 1");
    expect(lua).toContain(expectedInline);
  });

  it("chains statement transformation with all major rules together", () => {
    const code = `
      declare const value: number;
      declare const obj: { x: number; y: number };

      /** @inline */
      function helper(v: number): number {
        return Math.floor(v);
      }

      const a = helper(value);
      const b = Math.ceil(obj.x);
      const c = obj.y + obj.y;
      const d = Math.abs(3.14);
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "math-intrinsics": true,
          inline: true,
          localizer: true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("value - value % 1");
    expect(lua).not.toContain("helper(");
    expect(lua).toContain("math.ceil"); // Math.ceil preserved (not in math-intrinsics)
  });

  it("transforms nested statements with SourceFile visitor chaining", () => {
    const code = `
      declare const n: number;

      if (true) {
        const x = Math.floor(n);
        {
          const y = Math.ceil(x);
          const z = y + Math.floor(5.5);
        }
      }

      for (let i = 0; i < 10; i++) {
        const result = Math.abs(i);
      }
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "math-intrinsics": true,
          "merge-locals": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    // math-intrinsics transforms Math.floor(n) → n - n % 1
    expect(lua).toContain("n - n % 1");
    // math-intrinsics + constant-folding collapses Math.floor(5.5) → 5
    expect(lua).toContain("y + 5");
    // all Math.* calls are rewritten to lowercase math.*
    expect(lua).not.toContain("Math.");
  });
});

describe("index chaining — SourceFile statement fallback chains through superTransformStatements", () => {
  it("invokes superTransformStatements fallback when SourceFile visitor chains statements", () => {
    const code = `
      declare const val: number;

      const x = Math.floor(val);
      const y = x + x;
      const z = y + 1;
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "math-intrinsics": true,
          "merge-locals": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("val - val % 1"); // Math.floor transformed
    expect(lua).not.toContain("Math.floor"); // math-intrinsics and constant-folding were applied
  });

  it.each([
    {
      name: "chains SourceFile visitors through superTransformStatements with dead-local",
      code: `
        const unused = 42;
        const x = Math.floor(3.7);
        const y = x;
      `,
    },
    {
      name: "cleans up visitor entries when multiple SourceFile visitors exist",
      code: `
        const unused = Math.floor(5.5);
        const x = Math.floor(3.2);
        const y = x;
        const z = x + y;
      `,
    },
  ])("$name", ({ code }) => {
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "dead-local": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("x = 3");
  });

  it("applies SourceFile visitor chaining with localizer", () => {
    const code = `
      declare const obj: { x: number };

      const a = Math.floor(obj.x);
      const b = Math.ceil(obj.x);
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          localizer: true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    // localizer at default (function) scope does not hoist module-level chains;
    // both call sites emit the original property access unchanged.
    expect(lua).toContain("math.floor(obj.x)");
    expect(lua).toContain("math.ceil(obj.x)");
  });
});

describe("index chaining — visitor cleanup with multiple rules", () => {
  it("properly clears visitor entries when merging rules", () => {
    const code = `
      declare const val: number;

      const x = Math.floor(val);
      const y = Math.floor(val) + Math.floor(val);
    `;
    const options = {
      pluginOptions: {
        rules: {
          "conditional-compilation": true,
          "constant-folding": true,
          "math-intrinsics": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("val - val % 1");
    expect(lua).toContain("x =");
    expect(lua).toContain("y =");
  });

  it("handles visitor cleanup when three+ rules transform same kinds", () => {
    const code = `
      declare const a: number;
      declare const b: number;

      const sum = Math.floor(a) + Math.floor(b);
      const prod = Math.floor(a) * Math.floor(b);
    `;
    const options = {
      pluginOptions: {
        rules: {
          "conditional-compilation": true,
          "constant-folding": true,
          "math-intrinsics": true,
          "remove-empty-branch": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("a - a % 1");
    expect(lua).toContain("b - b % 1");
  });

  it("preserves correct behavior after visitor merge cleanup", () => {
    const code = `
      /** @inline */
      function inline1() {
        return 1;
      }

      /** @inline */
      function inline2() {
        return 2;
      }

      const a = inline1();
      const b = inline2();
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

    expect(lua).toContain("a = 1");
    expect(lua).toContain("b = 2");
  });

  it("maintains visitor integrity with all SourceFile-registered rules", () => {
    const code = `
      declare const obj: { prop: number };

      const result = Math.floor(obj.prop);
      const doubled = result + result;
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "merge-locals": true,
          localizer: true,
          "remove-empty-branch": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    // math-intrinsics is disabled → Math.floor stays as math.floor(obj.prop)
    expect(lua).toContain("math.floor(obj.prop)");
    expect(lua).toContain("result + result");
  });
});
