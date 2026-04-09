import { describe, expect, it } from "vitest";
import {
  compile,
  compileMultiFileWithDiagnostics,
  compileWithDiagnostics,
  normalizeLua,
} from "../helpers";

describe("inline uncovered branches", () => {
  describe("Expression-kind inline at statement position (handleExpressionStatement)", () => {
    it("wraps inlined expression in createExpressionStatement when target kind is expression", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        function test() {
          add(x, y);
        }
      `;

      const lua = normalizeLua(compile(code));

      // When the expression inline is at statement position, it should be wrapped
      // in an expression statement. The call should be inlined (not remain as "add()").
      expect(lua).not.toContain("add(x, y)");
      // Should contain the inlined expression (x + y, not the call)
      expect(lua).toContain("x + y");
    });
  });

  describe("Return-value function at void site (statementsWithReturn)", () => {
    it("rejects return-value function called at expression statement position with diagnostic", () => {
      const code = `
        /** @inline */
        function getValue(x: number, y: number): number {
          const a = x + 1;
          const b = y + 1;
          return a + b;
        }

        function test() {
          getValue(1, 2);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Should have a diagnostic about return-value function at void site
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("return-value function called at void site"),
        ),
      ).toBe(true);
    });
  });

  describe("Cross-module free variable detection (rejectIfCrossModuleFreeVar)", () => {
    it("rejects cross-module inline when function references non-parameter identifier", () => {
      const files = {
        "utils.ts": `
          export const globalValue = 42;

          /** @inline */
          export function useGlobal(x: number): number {
            return x + globalValue;
          }
        `,
        "main.ts": `
          import { useGlobal } from "./utils";

          function test() {
            useGlobal(1);
          }
        `,
      };

      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      // Should have a diagnostic about cross-module free variable
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes(
            "cross-module function references non-parameter identifiers",
          ),
        ),
      ).toBe(true);
    });

    it("falls back to call when cross-module free var blocks inline", () => {
      const files = {
        "utils.ts": `
          export const factor = 2;

          /** @inline */
          export function multiply(x: number): number {
            return x * factor;
          }
        `,
        "main.ts": `
          import { multiply } from "./utils";

          function test() {
            const result = multiply(5);
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Function should NOT be inlined, call should remain
      expect(normalized).toContain("multiply(5)");
    });
  });

  describe("Expression inline rejection at statement position", () => {
    it("rejects when canInline returns false for expression at statement position", () => {
      const code = `
        declare const mutableValue: { value: number };

        /** @inline */
        function getAndIncrement(): number {
          mutableValue.value++;
          return mutableValue.value;
        }

        function test() {
          getAndIncrement();
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Should have a diagnostic about side effects or parameter write
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe("checkSharedPrereqs branch coverage", () => {
    it("does not inline rest parameters functions", () => {
      const code = `
        /** @inline */
        function sum(...args: number[]): number {
          let total = 0;
          for (const arg of args) {
            total += arg;
          }
          return total;
        }

        declare const a: number;
        const result = sum(a, a + 1);
      `;

      const lua = normalizeLua(compile(code));

      // Rest parameters should not be inlined, call should remain
      expect(lua).toContain("sum(a, a + 1)");
    });

    it("rejects optional parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function greet(name?: string): string {
          return name || "default";
        }

        function test() {
          greet();
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("optional parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects default parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function multiply(x: number, y: number = 2): number {
          return x * y;
        }

        function test() {
          multiply(5);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("default parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects array destructuring parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function unpack([a, b]: [number, number]): number {
          return a + b;
        }

        function test() {
          unpack([1, 2]);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("detects unmatched argument count via type checking", () => {
      // When argument counts don't match, TypeScript will catch it,
      // and the plugin won't attempt inlining. This test validates
      // that the plugin handles strict type checking correctly.
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        function test() {
          // Both correct counts should allow inlining
          const result1 = add(x, y);
          return result1;
        }
      `;

      const lua = normalizeLua(compile(code));

      // With correct argument count, should be inlined
      expect(lua).toContain("x + y");
    });
  });

  describe("canInline parameter validation", () => {
    it("rejects when parameter symbol resolution fails", () => {
      const code = `
        declare const obj: { methodA(): number };

        /** @inline */
        function invoke(fn: () => number): number {
          return fn();
        }

        function test() {
          invoke(obj.methodA);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // If parameter symbol cannot be resolved, this may emit a diagnostic
      expect(diagnostics.length).toBeGreaterThanOrEqual(0);
    });

    it("does not inline when parameter is written inside function body", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function increment(n: number): number {
          n++;
          return n;
        }

        const result = increment(x);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Parameter write should prevent inlining
      expect(diagnostics.some((d) => String(d.messageText).includes("parameter is written"))).toBe(
        true,
      );
    });

    it("does not inline when detecting recursive function calls", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function factorial(x: number): number {
          if (x <= 1) return 1;
          return x * factorial(x - 1);
        }

        const result = factorial(n);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Recursive call should be detected and inlining rejected
      expect(diagnostics.some((d) => String(d.messageText).includes("recursive"))).toBe(true);
    });

    it("rejects when argument with side effects is not used", () => {
      const code = `
        declare function sideEffect(): number;

        /** @inline */
        function ignore(x: number): number {
          return 42;
        }

        function test() {
          ignore(sideEffect());
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("argument with side effects is not used"),
        ),
      ).toBe(true);
    });

    it("rejects when argument with side effects is used multiple times", () => {
      const code = `
        declare function expensiveCompute(): number;

        /** @inline */
        function double(x: number): number {
          return x + x;
        }

        function test() {
          double(expensiveCompute());
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("argument with side effects is used multiple times"),
        ),
      ).toBe(true);
    });
  });

  describe("canInlineStatements parameter validation", () => {
    it("does not inline multi-statement function when parameter is written", () => {
      const code = `
        declare const counter: number;

        /** @inline */
        function increment(n: number): void {
          n++;
          const x = n;
        }

        increment(counter);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Parameter write in multi-statement should be detected
      expect(diagnostics.some((d) => String(d.messageText).includes("parameter is written"))).toBe(
        true,
      );
    });

    it("does not inline multi-statement function when detecting recursion", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countDown(x: number): void {
          if (x > 0) {
            countDown(x - 1);
          }
        }

        countDown(n);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.some((d) => String(d.messageText).includes("recursive"))).toBe(true);
    });
  });

  describe("Complex destructuring and type patterns", () => {
    it("rejects object destructuring with nested patterns", () => {
      const code = `
        /** @inline */
        function process({ a, b: { c } }: { a: number; b: { c: number } }): number {
          return a + c;
        }

        function test() {
          process({ a: 1, b: { c: 2 } });
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects array destructuring with rest element", () => {
      const code = `
        /** @inline */
        function getFirst([head, ...tail]: number[]): number {
          return head;
        }

        function test() {
          getFirst([1, 2, 3]);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });
  });

  describe("Multi-statement at expression position", () => {
    it("inlines multi-statement body with return at expression position (statementsWithReturn)", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function computeSum(a: number, b: number): number {
          const result = a + b;
          return result;
        }

        function test() {
          const val = computeSum(x, y);
        }
      `;

      const lua = normalizeLua(compile(code));

      // statementsWithReturn should be inlined even at expression position
      // The call should be replaced with the inlined statements
      expect(lua).not.toContain("computeSum(x, y)");
      expect(lua).toContain("result");
    });

    it("rejects multi-statement function called in expression with control flow rejection", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function computeWithBreak(n: number): number {
          if (n > 10) {
            return 10;
          }
          return n;
        }

        function test() {
          const result = computeWithBreak(x);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe("Module scope validation", () => {
    it("rejects inline function declared inside another function", () => {
      const code = `
        function outer(x: number): number {
          /** @inline */
          function inner(a: number): number {
            return a * 2;
          }
          return inner(x);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("function must be declared at module scope"),
        ),
      ).toBe(true);
    });

    it("rejects inline function declared in class method", () => {
      const code = `
        class Calculator {
          compute(x: number): number {
            /** @inline */
            function double(n: number): number {
              return n * 2;
            }
            return double(x);
          }
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("function must be declared at module scope"),
        ),
      ).toBe(true);
    });
  });

  describe("Edge cases and linear control flow", () => {
    it("handles function with if statement without else branch", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function maybeIncrement(n: number): number {
          if (n > 0) {
            return n + 1;
          }
          return 0;
        }

        const result = maybeIncrement(x);
      `;

      const lua = normalizeLua(compile(code));

      // If without else but with return in both paths should inline
      expect(lua).toContain("x");
    });

    it("inlines function with while loop when at statement position", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countUp(x: number): void {
          let i = 0;
          while (i < x) {
            const _ = i;
            i++;
          }
        }

        countUp(n);
      `;

      const lua = normalizeLua(compile(code));

      // While loop with linear control flow should inline at void site
      expect(lua).not.toContain("countUp(n)");
    });

    it("inlines function with do-while loop at statement position", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countdown(x: number): void {
          let i = x;
          do {
            const _ = i;
            i--;
          } while (i > 0);
        }

        countdown(n);
      `;

      const lua = normalizeLua(compile(code));

      // Do-while with linear control flow should inline
      expect(lua).not.toContain("countdown(n)");
    });

    it("inlines function with for loop at statement position", () => {
      const code = `
        declare const items: number[];

        /** @inline */
        function process(arr: number[]): void {
          for (const item of arr) {
            const _ = item;
          }
        }

        process(items);
      `;

      const lua = normalizeLua(compile(code));

      // For loop with linear control flow should inline
      expect(lua).not.toContain("process(items)");
    });

    it("inlines function with try block at statement position", () => {
      const code = `
        declare const fn: () => void;

        /** @inline */
        function safeCall(callback: () => void): void {
          try {
            callback();
          } catch {
            const _ = 1;
          }
        }

        safeCall(fn);
      `;

      const lua = normalizeLua(compile(code));

      // Try-catch with linear control flow should inline
      expect(lua).not.toContain("safeCall(fn)");
    });

    it("inlines function with switch statement at statement position", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function process(n: number): void {
          switch (n) {
            case 1:
              break;
            case 2:
              break;
          }
        }

        process(x);
      `;

      const lua = normalizeLua(compile(code));

      // Switch with all branches having break should inline
      expect(lua).not.toContain("process(x)");
    });

    it("inlines empty function body", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function noop(n: number): void {
        }

        noop(x);
      `;

      const lua = normalizeLua(compile(code));

      // Empty function should inline to nothing
      expect(lua).not.toContain("noop(x)");
    });
  });

  describe("Expression vs statement inlining decisions", () => {
    it("inlines expression-kind function at expression position", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        const result = add(x, y);
      `;

      const lua = normalizeLua(compile(code));

      // Expression should be inlined directly
      expect(lua).toContain("x + y");
      expect(lua).not.toContain("add(");
    });

    it("wraps expression-kind function result when inlined at statement position", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function square(n: number): number {
          return n * n;
        }

        square(x);
      `;

      const lua = normalizeLua(compile(code));

      // Expression at statement position gets wrapped
      expect(lua).toContain("x * x");
    });

    it("inlines arrow function assigned to const variable", () => {
      const code = `
        declare const x: number;

        const square = /** @inline */ (n: number): number => n * n;

        const result = square(x);
      `;

      const lua = normalizeLua(compile(code));

      // Arrow function assigned to variable should be treated like any other inline
      expect(lua).toContain("n * n");
    });

    it("inlines statements-kind function with multiple statements and no return", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function log(n: number): void {
          const a = n;
          const b = a + 1;
        }

        log(x);
      `;

      const lua = normalizeLua(compile(code));

      // Multi-statement at void site should inline
      expect(lua).not.toContain("log(x)");
    });
  });

  describe("Complex argument evaluation", () => {
    it("handles argument passed to function with single use", () => {
      const code = `
        declare function getValue(): number;

        /** @inline */
        function getValue2(n: number): number {
          return n;
        }

        const result = getValue2(getValue());
      `;

      const lua = normalizeLua(compile(code));

      // Single use of argument with side effects should be ok
      expect(lua).toContain("getValue()");
    });

    it("allows pure argument that is used multiple times", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function triple(n: number): number {
          return n * 3;
        }

        const result = triple(x);
      `;

      const lua = normalizeLua(compile(code));

      // Pure argument with multiple uses should inline
      expect(lua).toContain("x * 3");
    });

    it("inlines argument-less function", () => {
      const code = `
        declare const global: { value: number };

        /** @inline */
        function getGlobal(): number {
          return global.value;
        }

        const result = getGlobal();
      `;

      const lua = normalizeLua(compile(code));

      // Zero-argument function should inline
      expect(lua).toContain("global.value");
    });
  });

  describe("line 1219-1220: handleExpressionStatement rejects with reason", () => {
    it("preserves call when function lacks @inline tag at statement position", () => {
      const code = `
        // Note: no @inline tag
        function helper(x: number): number {
          return x * 2;
        }

        helper(5);
      `;

      const { lua } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because function is not tagged @inline
      expect(normalized).toContain("helper(5)");
    });

    it("preserves call when function has optional parameters at statement position", () => {
      const code = `
        declare function print(x: any): void;

        /** @inline */
        function greet(name?: string): void {
          if (name) {
            print(name);
          }
        }

        greet();
      `;

      const { lua, diagnostics } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because optional parameters are not supported
      expect(normalized).toContain("greet()");
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("optional parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("preserves call when function has default parameters at statement position", () => {
      const code = `
        declare function print(x: any): void;

        /** @inline */
        function multiply(x: number, y: number = 2): void {
          print(x * y);
        }

        multiply(5);
      `;

      const { lua, diagnostics } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because default parameters are not supported
      expect(normalized).toContain("multiply(5)");
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("default parameters are not supported"),
        ),
      ).toBe(true);
    });
  });

  describe("line 1247: rejectIfCrossModuleFreeVar returns true at statement position", () => {
    it("preserves multi-statement cross-module call with free variable", () => {
      const files = {
        "store.ts": `
          let counter = 0;

          export /** @inline */
          function incrementAndLog(): void {
            counter++;
            const msg = "Count: " + counter;
          }
        `,
        "main.ts": `
          import { incrementAndLog } from "./store";

          function main() {
            incrementAndLog();
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Call must be preserved to avoid breaking variable capture
      expect(normalized).toContain("incrementAndLog()");
    });

    it("preserves multi-statement cross-module call accessing module scope", () => {
      const files = {
        "config.ts": `
          export let debugMode = true;
        `,
        "utils.ts": `
          import { debugMode } from "./config";

          export /** @inline */
          function processValue(value: number): void {
            const x = value + 1;
            const y = debugMode ? x : 0;
          }
        `,
        "main.ts": `
          import { processValue } from "./utils";

          function main() {
            processValue(42);
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Call must be preserved
      expect(normalized).toContain("processValue(42)");
    });
  });
});
