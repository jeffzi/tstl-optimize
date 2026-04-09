import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("conditional-compilation coverage", () => {
  const options = {
    pluginOptions: {
      rules: {
        "conditional-compilation": {
          enabled: true,
          constants: {
            TRUE_CONST: { env: "TRUE_CONST", default: true },
            FALSE_CONST: { env: "FALSE_CONST", default: false },
            VAL_1: { env: "VAL_1", default: 1 },
          },
        },
      },
    },
  };

  it("Line 89: containsBreakOrReturn with nested block", () => {
    const code = `
      declare function print(...args: any[]): void;
      function test() {
        if (true) {
          { return 1; }
        }
      }
      function test2() {
        while(true) {
          if (true) {
            { break; }
          }
        }
      }
    `;
    const lua = normalizeLua(compile(code, options));
    expect(lua).toContain("return 1");
    expect(lua).toContain("break");
  });

  it("Line 102: referencesKnownConstants with ParenthesizedExpression", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      if ((TRUE_CONST)) {
        print(1);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("if");
  });

  it("Line 109: referencesKnownConstants with unhandled expression kind", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      declare function foo(): any;
      // ObjectLiteralExpression is not handled by referencesKnownConstants
      // Using it in a way that doesn't trigger "always truthy" warning
      export const x = (foo() || { a: TRUE_CONST }) ? 1 : 2;
    `;
    const lua = normalizeLua(compile(code, options));
    expect(lua).toContain("or 2");
  });

  it("Line 168: tryFoldExpression for PrefixUnaryExpression", () => {
    const code = `
      declare const TRUE_CONST: boolean;
      export const x = !TRUE_CONST;
    `;
    const lua = normalizeLua(compile(code, options));
    expect(lua).toContain("x = false");
  });

  it("Lines 191-194: Partial folding warning for ConditionalExpression", () => {
    const code = `
      declare const TRUE_CONST: boolean;
      declare function foo(): boolean;
      export const x = (TRUE_CONST && foo()) ? 1 : 2;
    `;
    const lua = normalizeLua(compile(code, options));
    // Should stay as conditional expression but with TRUE_CONST folded to true
    expect(lua).toContain("true and foo()");
  });

  it("Lines 208-211: Partial folding warning for SwitchStatement", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      declare function foo(): number;
      switch (VAL_1 + foo()) {
        case 1: print(1); break;
      }
    `;
    const lua = normalizeLua(compile(code, options));
    expect(lua).toContain("1 + foo()");
  });

  it("ConditionalExpression with falsy constant condition", () => {
    const code = `
      declare function foo(): number;
      declare const FALSE_CONST: boolean;
      const x = FALSE_CONST ? 1 : foo();
    `;
    const lua = normalizeLua(compile(code, options));
    // FALSE_CONST is falsy, so only the false branch (foo()) should be in output
    expect(lua).toContain("foo()");
    // The condition and true branch should be eliminated
    expect(lua).not.toContain("? 1");
  });

  it("IfStatement with falsy constant and no else", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const FALSE_CONST: boolean;
      if (FALSE_CONST) {
        print(1);
      }
      print(2);
    `;
    const lua = normalizeLua(compile(code, options));
    // The if block should be stripped entirely
    expect(lua).not.toContain("print(1)");
    // But the following statement should remain
    expect(lua).toContain("print(2)");
  });

  it("IfStatement with truthy constant executes then branch", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      if (TRUE_CONST) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // True branch should be kept
    expect(lua).toContain("print(1)");
    // Else branch should be stripped
    expect(lua).not.toContain("print(2)");
  });

  it("Binary && operator short-circuits on falsy left", () => {
    const code = `
      declare function foo(): boolean;
      declare const FALSE_CONST: boolean;
      const x = FALSE_CONST && foo();
    `;
    const lua = normalizeLua(compile(code, options));
    // FALSE_CONST is falsy, entire expression becomes false
    expect(lua).toContain("false");
    // Right side should not be evaluated
    expect(lua).not.toContain("foo()");
  });

  it("Binary || operator short-circuits on truthy left", () => {
    const code = `
      declare function foo(): boolean;
      declare const TRUE_CONST: boolean;
      const x = TRUE_CONST || foo();
    `;
    const lua = normalizeLua(compile(code, options));
    // TRUE_CONST is truthy, entire expression becomes true
    expect(lua).toContain("true");
    // Right side should not be evaluated
    expect(lua).not.toContain("foo()");
  });

  it("Switch with constant value matching a case", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      switch (VAL_1) {
        case 1:
          print(1);
          break;
        case 2:
          print(2);
          break;
        default:
          print(0);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 defaults to 1, so case 1 should match
    expect(lua).toContain("print(1)");
    // Other cases should be stripped
    expect(lua).not.toContain("print(2)");
    expect(lua).not.toContain("print(0)");
  });

  it("Switch with constant value matching default", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      switch (VAL_1) {
        case 2:
          print(2);
          break;
        case 3:
          print(3);
          break;
        default:
          print(0);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 is 1, doesn't match any case, so default runs
    expect(lua).toContain("print(0)");
    // Explicit cases should be stripped
    expect(lua).not.toContain("print(2)");
    expect(lua).not.toContain("print(3)");
  });

  it("Switch with fallthrough (no break)", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      switch (VAL_1) {
        case 1:
          print(1);
        case 2:
          print(2);
          break;
        default:
          print(0);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 is 1, case 1 matches, then falls through to case 2
    expect(lua).toContain("print(1)");
    expect(lua).toContain("print(2)");
    // Default should not execute
    expect(lua).not.toContain("print(0)");
  });

  it("Switch with no matching case and no default", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      switch (VAL_1) {
        case 2:
          print(2);
          break;
        case 3:
          print(3);
          break;
      }
      print(4);
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 is 1, no match and no default, entire switch stripped
    expect(lua).not.toContain("print(2)");
    expect(lua).not.toContain("print(3)");
    // But following statement remains
    expect(lua).toContain("print(4)");
  });

  it("Negation of constant value", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      if (!TRUE_CONST) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // !TRUE_CONST is falsy, so else branch executes
    expect(lua).toContain("print(2)");
    expect(lua).not.toContain("print(1)");
  });

  it("Equality check between constants", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      if (VAL_1 === 1) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 defaults to 1, so VAL_1 === 1 is true
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("print(2)");
  });

  it("Inequality check between constants", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      if (VAL_1 !== 2) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 is 1, which is !== 2, so true branch
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("print(2)");
  });

  it("String constant in condition", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const STR_VAL: string;
      if (STR_VAL) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // Empty strings are falsy, but without a default, the constant can't be folded
    // This should preserve the condition
    expect(lua).toContain("STR_VAL");
  });

  it("Numeric zero constant is falsy", () => {
    const zeroOptions = {
      pluginOptions: {
        rules: {
          "conditional-compilation": {
            enabled: true,
            constants: {
              ZERO: { env: "ZERO", default: 0 },
            },
          },
        },
      },
    };
    const code = `
      declare function print(...args: any[]): void;
      declare const ZERO: number;
      if (ZERO) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, zeroOptions));
    // 0 is falsy, so else branch executes
    expect(lua).toContain("print(2)");
    expect(lua).not.toContain("print(1)");
  });

  it("Nested conditionals with constants", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      declare const FALSE_CONST: boolean;
      if (TRUE_CONST) {
        if (FALSE_CONST) {
          print(1);
        } else {
          print(2);
        }
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // Outer if is true, inner if is false, so print(2) executes
    expect(lua).toContain("print(2)");
    expect(lua).not.toContain("print(1)");
    // Outer if should be eliminated
    expect(lua).not.toContain("if");
  });

  it("containsBreakOrReturn with return inside nested block", () => {
    const oneConstantOptions = {
      pluginOptions: {
        rules: {
          "conditional-compilation": {
            enabled: true,
            constants: {
              ONE: { env: "ONE", default: 1 },
            },
          },
        },
      },
    };
    const code = `
      declare function print(...args: any[]): void;
      declare const ONE: number;
      function test() {
        switch (ONE) {
          case 1: {
            return 1;
          }
          case 2:
            print(2);
            break;
        }
      }
    `;
    const lua = normalizeLua(compile(code, oneConstantOptions));
    // Switch optimizes to case 1 (ONE defaults to 1)
    expect(lua).toContain("return 1");
    // case 2 is not reachable after optimization
    expect(lua).not.toContain("print(2)");
  });

  it("Boolean literals in conditions", () => {
    const code = `
      declare function print(...args: any[]): void;
      if (true) {
        print(1);
      }
      if (false) {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // true condition keeps branch
    expect(lua).toContain("print(1)");
    // false condition strips branch
    expect(lua).not.toContain("print(2)");
  });

  it("Switch with unresolved case expression", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function foo(): number;
      declare const VAL_1: number;
      switch (VAL_1) {
        case foo():
          print(1);
          break;
        case 2:
          print(2);
          break;
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // foo() is unresolved, so entire switch must be preserved
    expect(lua).toContain("foo()");
    expect(lua).toContain("switch");
  });

  it("Switch with constant but unresolved case, no default", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function foo(): number;
      declare const VAL_1: number;
      switch (VAL_1) {
        case foo():
          print(1);
          break;
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // foo() is unresolved, switch must be preserved even though no match
    expect(lua).toContain("switch");
    expect(lua).toContain("foo()");
  });

  it("As expression with constant", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const TRUE_CONST: boolean;
      if ((TRUE_CONST as boolean)) {
        print(1);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // as expressions unwrap to the underlying value
    expect(lua).toContain("print(1)");
  });

  it("Loose equality check between constants", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      if (VAL_1 == 1) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 defaults to 1, so VAL_1 == 1 is true
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("print(2)");
  });

  it("Loose inequality check between constants", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const VAL_1: number;
      if (VAL_1 != 2) {
        print(1);
      } else {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // VAL_1 is 1, which is != 2
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("print(2)");
  });

  it("Binary && with left operand returning undefined", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function foo(): boolean;
      declare const TRUE_CONST: boolean;
      const x = (TRUE_CONST && foo()) && true;
    `;
    const lua = normalizeLua(compile(code, options));
    // TRUE_CONST && foo() returns foo() (cannot fold), then && true
    expect(lua).toContain("foo()");
  });

  it("Binary || with left operand returning undefined", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function foo(): boolean;
      declare const FALSE_CONST: boolean;
      const x = (FALSE_CONST || foo()) || false;
    `;
    const lua = normalizeLua(compile(code, options));
    // FALSE_CONST || foo() returns foo() (cannot fold), then || false
    expect(lua).toContain("foo()");
  });

  it("Call expression in condition (unhandled expression type)", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function foo(): boolean;
      declare const TRUE_CONST: boolean;
      if (foo() && TRUE_CONST) {
        print(1);
      }
    `;
    const lua = normalizeLua(compile(code, options));
    // foo() is unhandled, so condition is preserved as-is
    expect(lua).toContain("foo()");
    expect(lua).toContain("if");
  });
});
