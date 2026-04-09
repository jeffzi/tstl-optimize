import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("debug-strip (uncovered branches)", () => {
  describe("config disabled (resolved === false branch)", () => {
    it("returns empty visitors when debug-strip config is explicitly false", () => {
      // This should trigger line 30: if (resolved === false) return {};
      const lua = compile(
        ["declare function print(msg: string): void;", 'print("debug");', "const x = 1;"].join(
          "\n",
        ),
        { pluginOptions: { rules: { "debug-strip": false } } },
      );
      // When config is false, no calls should be stripped
      expect(normalizeLua(lua)).toBe('print("debug")\nx = 1');
    });

    it("returns empty visitors when debug-strip is not provided in config", () => {
      // When rule is not configured, it should default to disabled
      const lua = compile(
        ["declare function print(msg: string): void;", 'print("debug");', "const x = 1;"].join(
          "\n",
        ),
        { pluginOptions: {} },
      );
      expect(normalizeLua(lua)).toBe('print("debug")\nx = 1');
    });

    it("handles namespace calls when debug-strip is disabled", () => {
      const lua = compile(
        [
          "declare namespace Debug { function log(msg: string): void; }",
          'Debug.log("test");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": false } } },
      );
      expect(normalizeLua(lua)).toBe('Debug.log("test")\nx = 1');
    });
  });

  describe("CallExpression with non-Identifier callee (line 17 branch)", () => {
    it("strips namespace method calls with CallExpression callee", () => {
      // This tests line 17: if (tstl.isCallExpression(expr))
      // The callee is not an Identifier (it's a TableIndexExpression)
      const lua = compile(
        [
          "declare namespace Debug { function log(msg: string): void; }",
          'Debug.log("test");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { namespaces: ["Debug"] } } } },
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("does not strip when namespace root is not in config", () => {
      const lua = compile(
        [
          "declare namespace Logger { function log(msg: string): void; }",
          'Logger.log("test");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { namespaces: ["Debug"] } } } },
      );
      expect(normalizeLua(lua)).toBe('Logger.log("test")\nx = 1');
    });

    it("strips multi-level namespace property access", () => {
      const lua = compile(
        [
          "declare namespace Debug { namespace Profiler { function start(): void; } }",
          "Debug.Profiler.start();",
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { namespaces: ["Debug"] } } } },
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });

    it("strips simple function calls from functions config", () => {
      const lua = compile(
        ["declare function debug(msg: string): void;", 'debug("test");', "const x = 1;"].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { functions: ["debug"] } } } },
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });
  });

  describe("callee with unresolvable root (if (root) false branch)", () => {
    it("preserves call when callee root is a call expression not a static identifier", () => {
      // getLogger().log("msg") compiles to getLogger().log("msg") in Lua.
      // rootIdentifier(callee.table) hits the base-case `return undefined` because
      // callee.table is a CallExpression, not an Identifier or TableIndexExpression.
      // This exercises the `if (root)` false branch → return false → call is NOT stripped.
      const lua = compile(
        [
          "declare function getLogger(): { log(msg: string): void };",
          'getLogger().log("msg");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { namespaces: ["getLogger"] } } } },
      );

      expect(normalizeLua(lua)).toBe('getLogger():log("msg")\nx = 1');
    });
  });

  describe("edge cases for uncovered branches", () => {
    it("preserves non-stripped calls alongside stripped ones", () => {
      const lua = compile(
        [
          "declare function print(msg: string): void;",
          "declare function debug(msg: string): void;",
          'print("info");',
          'debug("test");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "debug-strip": { functions: ["debug"] } } } },
      );
      expect(normalizeLua(lua)).toBe('print("info")\nx = 1');
    });

    it("strips both function and namespace calls simultaneously", () => {
      const lua = compile(
        [
          "declare function debug(msg: string): void;",
          "declare namespace Logger { function log(msg: string): void; }",
          'debug("test1");',
          'Logger.log("test2");',
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              "debug-strip": {
                functions: ["debug"],
                namespaces: ["Logger"],
              },
            },
          },
        },
      );
      expect(normalizeLua(lua)).toBe("x = 1");
    });
  });
});
