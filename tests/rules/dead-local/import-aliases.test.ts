import { describe, expect, it } from "vitest";
import { compile, compileMultiFileWithDiagnostics, normalizeLua } from "../../helpers";

describe("dead-local — import alias elimination", () => {
  it("removes dead alias when all cross-module @inline calls are inlined", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function is_zero(x: number): boolean {
          return x === 0;
        }
      `,
      "main.ts": `
        import { is_zero } from "./helper";
        const result = is_zero(5);
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).not.toContain("local is_zero");
    expect(normalized).not.toContain("____helper.is_zero");
    expect(normalized).not.toContain("____helper");
    expect(normalized).not.toContain('require("helper")');
  });

  it("removes orphaned require when all import aliases are dead", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function double(x: number): number {
          return x * 2;
        }
      `,
      "main.ts": `
        import { double } from "./helper";
        const result = double(21);
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).not.toContain("____helper");
    expect(normalized).not.toContain('require("helper")');
    expect(normalized).not.toContain("local double");
    // Inlined body may be constant-folded or kept as-is
    expect(normalized.includes("21 * 2") || normalized.includes("42")).toBeTruthy();
  });

  it("keeps alive alias with at least one surviving read", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function add(a: number, b: number): number {
          return a + b;
        }

        export function multiply(a: number, b: number): number {
          return a * b;
        }
      `,
      "main.ts": `
        import { add, multiply } from "./helper";
        const sum = add(2, 3);
        const product = multiply(4, 5);
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).not.toContain("local add");
    expect(normalized).toContain("local multiply");
    expect(normalized).toContain("____helper.multiply");
  });

  it("preserves alias and require for non-inlined import", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        export const config = { value: 42 };

        export function getValue(): number {
          return config.value;
        }
      `,
      "main.ts": `
        import { getValue } from "./helper";
        const result = getValue();
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).toContain("local getValue");
    expect(normalized).toContain("____helper");
    expect(normalized).toContain("getValue()");
  });

  it("removes only dead aliases and keeps require alive when any alias survives", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function is_zero(x: number): boolean {
          return x === 0;
        }

        export function format(x: number): string {
          return x.toString();
        }
      `,
      "main.ts": `
        import { is_zero, format } from "./helper";
        const result = is_zero(5);
        const text = format(42);
      `,
    });
    const normalized = normalizeLua(lua);
    // is_zero is inlined so its alias is dead; format is live so it and its require stay
    expect(normalized).not.toContain("local is_zero");
    expect(normalized).toContain("local format");
    expect(normalized).toContain("____helper.format");
    expect(normalized).toContain("____helper");
    expect(normalized).toContain('require("helper")');
  });

  it("does not modify module-scope or single-file locals (no import context)", () => {
    // Module scope: const x = 1
    const moduleLua = compile("const x = 1;", {
      pluginOptions: { rules: { "constant-propagation": false } },
    });
    expect(moduleLua).toContain("x = 1");

    // Single-file function scope (no imports)
    const functionLua = compile(
      `
      function f() {
        const x = 1;
        return x;
      }
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    expect(functionLua).toContain("x = 1");
    expect(functionLua).toContain("return x");
  });

  it("removes alias when local re-export of inlined function survives with no other reads", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function triple(x: number): number {
          return x * 3;
        }
      `,
      "main.ts": `
        import { triple } from "./helper";
        export const exported = triple(10);
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).not.toContain("local triple");
    expect(normalized).not.toContain("____helper.triple");
    expect(normalized).not.toContain("____helper");
    expect(normalized).not.toContain('require("helper")');
    // Inlined body may be constant-folded or kept as-is
    expect(normalized.includes("10 * 3") || normalized.includes("30")).toBeTruthy();
  });

  it("preserves alias when used in closure capture", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        export function process(x: number): number {
          return x * 2;
        }
      `,
      "main.ts": `
        import { process } from "./helper";
        const fn = () => process(5);
        export const result = fn();
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).toContain("local process");
    expect(normalized).toContain("____helper.process");
  });

  it("handles multiple require bindings independently", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "lib1.ts": `
        /** @inline */
        export function a(): number { return 1; }
      `,
      "lib2.ts": `
        export function b(): number { return 2; }
      `,
      "main.ts": `
        import { a } from "./lib1";
        import { b } from "./lib2";
        const x = a();
        const y = b();
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).not.toContain("____lib1");
    expect(normalized).toContain("____lib2");
    expect(normalized).toContain("____lib2.b");
  });

  it("does not treat non-require table access as import alias", () => {
    const { lua } = compileMultiFileWithDiagnostics({
      "helper.ts": `
        /** @inline */
        export function noop(): void {}
      `,
      "main.ts": `
        import { noop } from "./helper";
        declare const globalObj: { prop: number };
        noop();
        export const val = globalObj.prop;
      `,
    });
    const normalized = normalizeLua(lua);
    expect(normalized).toContain("globalObj.prop");
  });
});
