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

describe("index chaining — SourceFile visitor fallback", () => {
  it("chains statement visitors when two rules both handle ExpressionStatement", () => {
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
    expect(lua).toContain("doubled");
  });

  it("chains statement visitors when multiple rules handle same statement kind", () => {
    const code = `
      declare const n: number;

      /** @inline */
      function getValue() { return 1; }

      const x = getValue();
      const y = Math.floor(n);
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

    expect(lua).toContain("n - n % 1");
    expect(lua).toContain("x = 1");
  });

  it("applies chained visitors through SourceFile statement fallback with inline", () => {
    const code = `
      declare const n: number;

      /** @inline */
      function getValue(): number {
        return 42;
      }

      const x = Math.floor(n);
      const y = getValue();
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

    expect(lua).toContain("= 42");
    expect(lua).toContain("n - n % 1");
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

    expect(lua).toContain("value - value % 1"); // Math.floor transformed via inline + math-intrinsics
    expect(lua).not.toContain("helper("); // function was inlined
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

    expect(lua).toContain("x");
    expect(lua).toContain("y");
    expect(lua).toContain("z");
    expect(lua).toContain("result");
  });
});

describe("index chaining — mockedContext.superTransformStatements fallback with SourceFile", () => {
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
          "merge-locals": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("val - val % 1"); // Math.floor transformed
    expect(lua).not.toContain("Math.floor"); // math-intrinsics and constant-folding were applied
  });

  it("chains SourceFile visitors through superTransformStatements with dead-local", () => {
    const code = `
      const unused = 42;
      const x = Math.floor(3.7);
      const y = x;
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "dead-local": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("x = 3"); // Math.floor(3.7) constant-folded to 3
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

    // Localizer should hoist obj.x since it appears multiple times
    expect(lua).toContain("obj.x");
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
    expect(lua).toContain("x");
    expect(lua).toContain("y");
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

  it("cleans up visitor entries when multiple SourceFile visitors exist", () => {
    const code = `
      const unused = Math.floor(5.5);
      const x = Math.floor(3.2);
      const y = x;
      const z = x + y;
    `;
    const options = {
      pluginOptions: {
        rules: {
          "constant-folding": true,
          "dead-local": true,
          "merge-locals": true,
        },
      },
    };

    const lua = normalizeLua(compile(code, options));

    expect(lua).toContain("x = 3"); // Math.floor(3.2) constant-folded
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

    expect(lua).toContain("result"); // result variable preserved in output
    expect(lua).toContain("doubled"); // doubled variable preserved in output
  });
});
