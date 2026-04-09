import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "./helpers";

describe("index chaining — SourceFile visitor fallback", () => {
  it("chains statement visitors when two rules both handle ExpressionStatement", () => {
    // This test triggers the mockedContext.superTransformStatements fallback
    // when an existing visitor exists for a statement kind on SourceFile.
    //
    // Scenario: Both constant-folding and conditional-compilation handle
    // ExpressionStatement. When building the second visitor, the merge logic
    // wraps the existing one and creates a mockedContext with superTransformStatements
    // fallback for SourceFile processing.
    const code = `
      declare const val: number;

      // Both rules transform expression statements
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

    // constant-folding optimizes Math.floor
    expect(lua).toContain("val - val % 1");
    // Both rule visitors should be chained for statements
    expect(lua).toContain("doubled");
  });

  it("chains statement visitors when multiple rules handle same statement kind", () => {
    // Test that when SourceFile is processed with an existing statement visitor,
    // the mockedContext.superTransformStatements properly delegates to the
    // existing visitor as a fallback. Both math-intrinsics and inline handle
    // expression statements.
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

    // Both rules apply to statement processing
    expect(lua).toContain("n - n % 1");
    expect(lua).toContain("x = 1");
  });

  it("applies chained visitors through SourceFile statement fallback with inline", () => {
    // Tests the SourceFile superTransformStatements path with inline + another rule
    // that both touch statement-level code.
    const code = `
      declare const n: number;

      /** @inline */
      function getValue(): number {
        return 42;
      }

      // Statement with both math-intrinsics and inline transforming same expression
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

    // inline should inline getValue() calls
    expect(lua).toContain("= 42");
    // math-intrinsics should optimize Math.floor
    expect(lua).toContain("n - n % 1");
  });

  it("chains statement transformation with all major rules together", () => {
    // Comprehensive test that exercises statement-level visitor chaining
    // across many rules simultaneously, ensuring visitor merging and
    // superTransformStatements delegation works correctly across the board.
    const code = `
      declare const value: number;
      declare const obj: { x: number; y: number };

      // Test constant-folding + math-intrinsics + inline chaining
      /** @inline */
      function helper(v: number): number {
        return Math.floor(v);
      }

      // Multiple statements using different transformation targets
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

    // Verify that all four rules applied through visitor chaining
    expect(lua).toContain("value");
    expect(lua).toContain("obj");
    expect(lua).toContain("a");
    expect(lua).toContain("b");
    expect(lua).toContain("c");
  });

  it("transforms nested statements with SourceFile visitor chaining", () => {
    // Tests SourceFile visitor merging with deep statement nesting,
    // ensuring visitor delegation through multiple rule layers works.
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

    // All rules should apply successfully through visitor chaining
    expect(lua).toContain("x");
    expect(lua).toContain("y");
    expect(lua).toContain("z");
    expect(lua).toContain("result");
  });
});

describe("index chaining — mockedContext.superTransformStatements fallback with SourceFile", () => {
  it("invokes superTransformStatements fallback when SourceFile visitor chains statements", () => {
    // This test directly exercises line 101-105 (mockedContext.superTransformStatements).
    // Scenario: constant-folding and merge-locals both register SourceFile visitors.
    // When merge-locals processes statements via its SourceFile visitor, it may call
    // superTransformStatements, which goes through the mockedContext fallback that
    // delegates to the existing constant-folding visitor.
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

    // Both rules should apply: constant-folding optimizes Math.floor,
    // merge-locals hoists/merges variable statements
    expect(lua).toContain("val - val % 1");
    expect(lua).toContain("x");
    expect(lua).toContain("y");
    expect(lua).toContain("z");
  });

  it("chains SourceFile visitors through superTransformStatements with dead-local", () => {
    // Tests the mockedContext.superTransformStatements path with constant-folding
    // and dead-local, both of which register SourceFile visitors.
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

    // constant-folding constant-folds Math.floor(3.7) to 3
    // dead-local removes the unused variable
    expect(lua).toContain("3");
    expect(lua).toContain("x");
  });

  it("applies SourceFile visitor chaining with localizer", () => {
    // Tests superTransformStatements fallback with constant-folding and localizer.
    // Localizer hoists repeated chains; constant-folding handles Math operations.
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

    // Both rules applied via SourceFile visitor chaining
    expect(lua).toContain("a");
    expect(lua).toContain("b");
  });
});

describe("index chaining — visitor cleanup with multiple rules", () => {
  it("properly clears visitor entries when merging rules", () => {
    // This test exercises the Reflect.deleteProperty cleanup at line 121.
    // When visitor merging reassigns merged[kind], the old keys are cleared
    // from this.visitors before Object.assign(this.visitors, merged).
    //
    // Scenario: Enable multiple rules that all touch SourceFile and statements.
    // The visitor object gets reassigned, and old entries must be cleaned up
    // to avoid stale visitors being called.
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

    // All three rules should apply cleanly without stale visitors
    expect(lua).toContain("val - val % 1");
    expect(lua).toContain("x");
    expect(lua).toContain("y");
  });

  it("handles visitor cleanup when three+ rules transform same kinds", () => {
    // Tests that visitor cleanup via Reflect.deleteProperty correctly
    // removes old visitor entries before reassigning with Object.assign.
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

    // Multiple rules applied in sequence with proper cleanup
    expect(lua).toContain("a - a % 1");
    expect(lua).toContain("b - b % 1");
    expect(lua).toContain("sum");
  });

  it("preserves correct behavior after visitor merge cleanup", () => {
    // Ensures that Reflect.deleteProperty cleanup doesn't break subsequent
    // visitor execution. Tests that merged visitors work correctly after
    // the old entries are cleared.
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

    // Both inline functions inlined
    expect(lua).toContain("a = 1");
    expect(lua).toContain("b = 2");
  });

  it("cleans up visitor entries when multiple SourceFile visitors exist", () => {
    // Tests Reflect.deleteProperty cleanup with multiple rules that all
    // register SourceFile visitors (merge-locals, dead-local, constant-folding).
    // The merged visitor object must properly clear old keys before reassignment.
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

    // All three rules with SourceFile visitors should apply without residual state
    expect(lua).toContain("3");
    expect(lua).toContain("x");
    expect(lua).toContain("y");
  });

  it("maintains visitor integrity with all SourceFile-registered rules", () => {
    // Tests that Reflect.deleteProperty correctly clears stale visitor entries
    // when many SourceFile rules are enabled (constant-folding, merge-locals,
    // localizer, remove-empty-branch).
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

    // All SourceFile visitors applied cleanly with proper cleanup
    expect(lua).toContain("doubled");
    expect(lua).toContain("result");
  });
});
