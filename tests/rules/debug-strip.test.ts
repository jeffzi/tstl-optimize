import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/debug-strip";
import { compile, normalizeLua } from "../helpers";

const enabled = {
  pluginOptions: { rules: { "constant-propagation": false, "debug-strip": true } },
};

const ENV =
  "declare function print(...args: unknown[]): void;\ndeclare function assert(cond: unknown, msg?: string): asserts cond;\n";

function parseExpressionStatement(source: string): ts.ExpressionStatement {
  const file = ts.createSourceFile("debug-strip.ts", source, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    throw new Error("Expected expression statement.");
  }
  return statement;
}

function createMockTypeChecker(overrides: Partial<ts.TypeChecker> = {}): ts.TypeChecker {
  return {
    getSymbolAtLocation: () => undefined,
    getTypeOfSymbol: () => ({}),
    typeToString: () => "",
    ...overrides,
  } as ts.TypeChecker;
}

describe("debug-strip", () => {
  describe("when function calls match the strip list", () => {
    it.each([
      { name: "print with string arg", code: `${ENV}print("hello"); const x = 1;` },
      {
        name: "assert with cond",
        code: `${ENV}declare const cond: boolean; assert(cond); const x = 1;`,
      },
      { name: "print with multiple args", code: `${ENV}print("x", "y", "z"); const x = 1;` },
    ])("strips $name call in statement position", ({ code }) => {
      expect(normalizeLua(compile(code, enabled))).toBe("x = 1");
    });

    it("does not strip unlisted functions", () => {
      const lua = compile("declare function foo(): void; foo();", enabled);
      expect(normalizeLua(lua)).toBe("foo()");
    });
  });

  describe("when namespace method calls match the strip list", () => {
    it.each([
      {
        name: "debug.traceback()",
        code: "declare namespace debug { function traceback(): string; } debug.traceback(); const x = 1;",
      },
      {
        name: "namespace call with arguments",
        code: [
          "declare namespace debug { function sethook(fn: () => void, mask: string, count: number): void; }",
          'debug.sethook(() => {}, "c", 0);',
          "const x = 1;",
        ].join("\n"),
      },
      {
        name: "two-level nested namespace call (debug.profiler.start())",
        code: [
          "declare namespace debug { namespace profiler { function start(): void; } }",
          "debug.profiler.start();",
          "const x = 1;",
        ].join("\n"),
      },
      {
        name: "three-level nested namespace call (debug.profiler.hooks.begin())",
        code: [
          "declare namespace debug { namespace profiler { namespace hooks { function begin(): void; } } }",
          "debug.profiler.hooks.begin();",
          "const x = 1;",
        ].join("\n"),
      },
    ])("strips $name", ({ code }) => {
      expect(normalizeLua(compile(code, enabled))).toBe("x = 1");
    });
  });

  describe("when return value is used", () => {
    it.each([
      {
        name: "variable initializer",
        code: 'declare function print(msg: string): string; const x = print("x");',
        expected: 'x = print("x")',
      },
      {
        name: "function return value",
        code: [
          "declare function assert<T>(v: T): T;",
          "function check(v: number): number { return assert(v); }",
        ].join("\n"),
        expected: "function check(v)\nreturn assert(v)\nend",
      },
      {
        name: "function argument",
        code: [
          "declare function print(msg: string): string;",
          "declare function foo(s: string): void;",
          'foo(print("x"));',
        ].join("\n"),
        expected: 'foo(print("x"))',
      },
    ])("keeps call used as $name", ({ code, expected }) => {
      expect(normalizeLua(compile(code, enabled))).toContain(expected);
    });
  });

  describe("when config is customized", () => {
    it("custom functions list replaces defaults", () => {
      const lua = compile(
        `${ENV}declare function myDebug(msg: string): void; print("a"); myDebug("b");`,
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { functions: ["myDebug"] } },
          },
        },
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
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["profiler"] } },
          },
        },
      );
      expect(normalizeLua(lua)).toBe("debug.traceback()");
    });

    it.each([
      { name: "false (boolean)", options: { pluginOptions: { rules: { "debug-strip": false } } } },
      {
        name: "{ enabled: false }",
        options: { pluginOptions: { rules: { "debug-strip": { enabled: false } } } },
      },
    ])("disabling via $name preserves all calls", ({ options }) => {
      expect(normalizeLua(compile(`${ENV}print("hello");`, options))).toBe('print("hello")');
    });
  });

  describe("when code mixes stripped and non-stripped statements", () => {
    it("strips only targeted calls among multiple statements", () => {
      const lua = compile(
        `${ENV}${[
          "declare const hp: number;",
          "declare function heal(n: number): void;",
          'print("player health:", hp);',
          "assert(hp > 0);",
          "heal(10);",
          'print("healed");',
        ].join("\n")}`,
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
        `${ENV}${[
          "declare const hp: number;",
          "declare const mp: number;",
          "print(",
          '  "stats:",',
          "  hp,",
          "  mp",
          ");",
          "const x = hp + mp;",
        ].join("\n")}`,
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
        `${ENV}${[
          "declare namespace debug { function traceback(): string; }",
          "declare const n: number;",
          'print("start");',
          "debug.traceback();",
          "const result = n * 2;",
          "assert(n > 0);",
        ].join("\n")}`,
        enabled,
      );
      expect(normalizeLua(lua)).toBe("result = n * 2");
    });
  });

  describe("when callee is not a simple identifier", () => {
    it("keeps IIFE (callee is FunctionExpression, not in any strip list)", () => {
      const lua = compile("(function() { let a = 1; return a; })(); const x = 1;", enabled);
      expect(normalizeLua(lua)).toBe("(function()\nlocal a = 1\nreturn a\nend)()\nx = 1");
    });
  });

  describe("when combined with other rules", () => {
    it("coexists with other rules (different SyntaxKinds)", () => {
      const lua = compile(
        [
          "declare function print(...args: unknown[]): void;",
          "declare const x: number;",
          "const a = Math.sqrt(x);",
          'print("debug");',
        ].join("\n"),
        enabled,
      );
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("a =");
      expect(normalized).toContain("^ 0.5");
    });
  });

  describe("when config is disabled", () => {
    it("preserves all calls when not provided in config", () => {
      const lua = compile(
        ["declare function print(msg: string): void;", 'print("debug");', "const x = 1;"].join(
          "\n",
        ),
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      expect(normalizeLua(lua)).toBe('print("debug")\nx = 1');
    });

    it("preserves namespace calls when rule is disabled", () => {
      const lua = compile(
        [
          "declare namespace Debug { function log(msg: string): void; }",
          'Debug.log("test");',
          "const x = 1;",
        ].join("\n"),
        { pluginOptions: { rules: { "constant-propagation": false, "debug-strip": false } } },
      );
      expect(normalizeLua(lua)).toBe('Debug.log("test")\nx = 1');
    });
  });

  describe("when namespace or nested callees are targeted", () => {
    it("does not strip when namespace root is not in config", () => {
      const lua = compile(
        [
          "declare namespace Logger { function log(msg: string): void; }",
          'Logger.log("test");',
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["Debug"] } },
          },
        },
      );
      expect(normalizeLua(lua)).toBe('Logger.log("test")\nx = 1');
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
              "constant-propagation": false,
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

    it("preserves a top-level local function alias even when the configured global function is stripped", () => {
      const lua = compile(["const debug = () => 1;", "debug();", "const x = 1;"].join("\n"), {
        pluginOptions: {
          rules: { "constant-propagation": false, "debug-strip": { functions: ["debug"] } },
        },
      });

      const normalized = normalizeLua(lua);
      expect(normalized).toContain("____debug()");
      expect(normalized).toContain("x = 1");
    });

    it("preserves a top-level local namespace object even when the configured global namespace is stripped", () => {
      const lua = compile(
        [
          "const Logger = {",
          "  log(_msg: string) {",
          "    return 1;",
          "  },",
          "};",
          'Logger.log("local");',
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["Logger"] } },
          },
        },
      );

      const normalized = normalizeLua(lua);
      expect(normalized).toContain('Logger:log("local")');
      expect(normalized).toContain("x = 1");
    });

    it("preserves calls on shadowing locals even when the global namespace is stripped", () => {
      const lua = compile(
        [
          "declare namespace debug { function traceback(): string; }",
          "function run(debug: { traceback(): string }) {",
          "  debug.traceback();",
          "}",
          "debug.traceback();",
          "const x = 1;",
        ].join("\n"),
        enabled,
      );

      const normalized = normalizeLua(lua);
      expect(normalized).toContain("function run(");
      expect(normalized).toContain(":traceback()");
      expect(normalized).toContain("x = 1");
    });

    it("strips the configured global namespace without stripping a shadowing parameter", () => {
      const lua = compile(
        [
          "declare namespace Logger { function log(msg: string): void; }",
          "function run(Logger: { log(msg: string): void }) {",
          '  Logger.log("local");',
          "}",
          'Logger.log("global");',
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["Logger"] } },
          },
        },
      );

      expect(normalizeLua(lua)).toBe('function run(Logger)\nLogger:log("local")\nend\nx = 1');
    });

    it("strips method-call syntax when the configured namespace matches the receiver root", () => {
      const lua = compile(
        ["declare const logger: { debug(): void };", "logger.debug();", "const x = 1;"].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["logger"] } },
          },
        },
      );

      expect(normalizeLua(lua)).toBe("x = 1");
    });
  });

  describe("when callee root has a non-global declaration kind", () => {
    it("does not strip calls when the identifier is backed by a class declaration", () => {
      // isStripSafeGlobalDeclaration reaches its catch-all return false (line 47) for
      // ClassDeclaration — not a VariableDeclaration, BindingElement, Parameter,
      // FunctionDeclaration, or ModuleDeclaration — so every() returns false and the
      // call is NOT stripped.
      const lua = compile(
        [
          "declare class debug { static traceback(): string; }",
          "debug.traceback();",
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["debug"] } },
          },
        },
      );

      const normalized = normalizeLua(lua);
      expect(normalized).toContain("traceback");
      expect(normalized).toContain("x = 1");
    });
  });

  describe("when callee is computed dynamically", () => {
    it("preserves call when callee root is a dynamic expression, not a static identifier", () => {
      // getLogger().log("msg") — rootIdentifier hits the base-case `return undefined` because
      // callee.table is a CallExpression → call is NOT stripped
      const lua = compile(
        [
          "declare function getLogger(): { log(msg: string): void };",
          'getLogger().log("msg");',
          "const x = 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { "constant-propagation": false, "debug-strip": { namespaces: ["getLogger"] } },
          },
        },
      );

      expect(normalizeLua(lua)).toBe('getLogger():log("msg")\nx = 1');
    });
  });

  describe("public visitor coverage", () => {
    it("returns no visitors when the rule is disabled", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        createMockTypeChecker(),
        { rules: { "debug-strip": false } },
      ]);

      expect(visitors).toStrictEqual({});
    });

    it("treats missing checker symbols as configured globals", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        createMockTypeChecker({ getSymbolAtLocation: () => undefined }),
        { rules: { "debug-strip": { functions: ["print"] } } },
      ]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ExpressionStatement) as (
        node: ts.ExpressionStatement,
        context: tstl.TransformationContext,
      ) => tstl.Statement[];

      const transformed = Reflect.apply(visitor, undefined, [
        parseExpressionStatement('print("debug");'),
        {
          superTransformStatements: () => ["kept"],
        } as unknown as tstl.TransformationContext,
      ]);

      expect(transformed).toEqual([]);
    });

    it("passes through non-call expression statements", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        createMockTypeChecker({ getSymbolAtLocation: () => undefined }),
        { rules: { "debug-strip": { functions: ["print"] } } },
      ]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ExpressionStatement) as (
        node: ts.ExpressionStatement,
        context: tstl.TransformationContext,
      ) => unknown;

      const transformed = Reflect.apply(visitor, undefined, [
        parseExpressionStatement("print;"),
        {
          superTransformStatements: () => ["kept"],
        } as unknown as tstl.TransformationContext,
      ]);

      expect(transformed).toEqual(["kept"]);
    });
  });
});
