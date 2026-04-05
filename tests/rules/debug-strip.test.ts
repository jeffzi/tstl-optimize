import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

const enabled = { pluginOptions: { rules: { "debug-strip": true } } };

describe("debug-strip", () => {
  describe("functions (bare function stripping)", () => {
    it("strips default-listed function calls in statement position", () => {
      const lua1 = compile('print("hello"); const x = 1;', enabled);
      expect(normalizeLua(lua1)).toBe("x = 1");

      const lua2 = compile("declare const cond: boolean; assert(cond); const x = 1;", enabled);
      expect(normalizeLua(lua2)).toBe("x = 1");

      const lua3 = compile('print("x", "y", "z"); const x = 1;', enabled);
      expect(normalizeLua(lua3)).toBe("x = 1");
    });

    it("does not strip unlisted functions", () => {
      const lua = compile("declare function foo(): void; foo();", enabled);
      expect(normalizeLua(lua)).toBe("foo()");
    });
  });

  describe("namespaces (namespace method stripping)", () => {
    it("strips debug.traceback()", () => {
      const lua = compile(
        "declare namespace debug { function traceback(): string; } debug.traceback(); const x = 1;",
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("strips namespace call with arguments", () => {
      const lua = compile(
        [
          "declare namespace debug { function sethook(fn: () => void, mask: string, count: number): void; }",
          'debug.sethook(() => {}, "c", 0);',
          "const x = 1;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("strips two-level nested namespace call (debug.profiler.start())", () => {
      const lua = compile(
        [
          "declare namespace debug { namespace profiler { function start(): void; } }",
          "debug.profiler.start();",
          "const x = 1;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("strips three-level nested namespace call (debug.profiler.hooks.begin())", () => {
      const lua = compile(
        [
          "declare namespace debug { namespace profiler { namespace hooks { function begin(): void; } } }",
          "debug.profiler.hooks.begin();",
          "const x = 1;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });
  });

  describe("preserves (return value used — must NOT strip)", () => {
    it("keeps calls when return value is used", () => {
      const asInit = compile(
        'declare function print(msg: string): string; const x = print("x");',
        enabled,
      );
      expect(normalizeLua(asInit)).toBe('x = print("x")');

      const asReturn = compile(
        [
          "declare function assert<T>(v: T): T;",
          "function check(v: number): number { return assert(v); }",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(asReturn)).toBe("function check(v)\nreturn assert(v)\nend");

      const asArg = compile(
        [
          "declare function print(msg: string): string;",
          "declare function foo(s: string): void;",
          'foo(print("x"));',
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(asArg)).toBe('foo(print("x"))');
    });
  });

  describe("config", () => {
    it("custom functions list replaces defaults", () => {
      const lua = compile(
        'declare function myDebug(msg: string): void; print("a"); myDebug("b");',
        { pluginOptions: { rules: { "debug-strip": { functions: ["myDebug"] } } } },
      );
      expect(normalizeLua(lua)).toBe('print("a")');
    });

    it("custom namespaces list replaces defaults", () => {
      const lua = compile(
        [
          "declare namespace debug { function traceback(): string; }",
          "declare namespace profiler { function start(): void; }",
          "debug.traceback();",
          "profiler.start();",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { namespaces: ["profiler"] } } } },
      );
      expect(normalizeLua(lua)).toBe("debug.traceback()");
    });

    it("disabling the rule preserves all calls", () => {
      const viaFalse = compile('print("hello");', {
        pluginOptions: { rules: { "debug-strip": false } },
      });
      expect(normalizeLua(viaFalse)).toBe('print("hello")');

      const viaEnabled = compile('print("hello");', {
        pluginOptions: { rules: { "debug-strip": { enabled: false } } },
      });
      expect(normalizeLua(viaEnabled)).toBe('print("hello")');
    });
  });

  describe("multi-line (mixed stripped and kept statements)", () => {
    it("strips only targeted calls among multiple statements", () => {
      const lua = compile(
        [
          "declare const hp: number;",
          "declare function heal(n: number): void;",
          'print("player health:", hp);',
          "assert(hp > 0);",
          "heal(10);",
          'print("healed");',
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("heal(10)");
    });

    it("strips multiple namespace calls interspersed with other code", () => {
      const lua = compile(
        [
          "declare namespace debug { function traceback(): string; function sethook(): void; }",
          "declare const x: number;",
          "debug.traceback();",
          "const a = x + 1;",
          "debug.sethook();",
          "const b = x + 2;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("a = x + 1\nb = x + 2");
    });

    it("strips a call whose arguments span multiple lines", () => {
      const lua = compile(
        [
          "declare const hp: number;",
          "declare const mp: number;",
          "print(",
          '  "stats:",',
          "  hp,",
          "  mp",
          ");",
          "const x = hp + mp;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = hp + mp");
    });

    it("strips a namespace call whose arguments span multiple lines", () => {
      const lua = compile(
        [
          "declare namespace debug { function sethook(fn: () => void, mask: string, count: number): void; }",
          "debug.sethook(",
          "  () => {},",
          '  "c",',
          "  0",
          ");",
          "const x = 1;",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("strips mixed function and namespace calls in one block", () => {
      const lua = compile(
        [
          "declare namespace debug { function traceback(): string; }",
          "declare const n: number;",
          'print("start");',
          "debug.traceback();",
          "const result = n * 2;",
          "assert(n > 0);",
        ].join("\n"),
        enabled,
      );
      expect(normalizeLua(lua)).toBe("result = n * 2");
    });
  });

  describe("preserves non-identifier callees", () => {
    it("keeps IIFE (callee is FunctionExpression, not in any strip list)", () => {
      const lua = compile("(function() { const a = 1; })(); const x = 1;", enabled);
      expect(normalizeLua(lua)).toBe("(function()\nlocal a = 1\nend)()\nx = 1");
    });
  });

  describe("interaction", () => {
    it("coexists with other rules (different SyntaxKinds)", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.floor(x);", 'print("debug");'].join("\n"),
        { pluginOptions: { rules: { "debug-strip": true } } },
      );
      expect(normalizeLua(lua)).toBe("a = x - x % 1");
    });
  });
});
