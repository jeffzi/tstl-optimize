import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { walkStatements } from "../../src/ast/lua-walker";
import { createVisitors } from "../../src/rules/math-intrinsics";
import { compile, normalizeLua } from "../helpers";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function expectLuaSnippets(
  lua: string,
  { contains, excludes = [] }: { contains: readonly string[]; excludes?: readonly string[] },
): void {
  for (const snippet of contains) {
    expect(lua, `expected Lua to contain snippet: ${snippet}`).toContain(snippet);
  }

  for (const snippet of excludes) {
    expect(lua, `expected Lua to exclude snippet: ${snippet}`).not.toContain(snippet);
  }
}

function parseCallExpression(source: string): ts.CallExpression {
  const sourceFile = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements[0];
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    throw new Error("Expected first statement to be a call expression.");
  }
  return statement.expression;
}

function collectExpressionReferences(expression: tstl.Expression): tstl.Expression[] {
  const refs: tstl.Expression[] = [];
  walkStatements([tstl.createExpressionStatement(expression)], {
    expr: (node) => {
      refs.push(node);
    },
  });
  return refs;
}

describe("math-intrinsics", () => {
  describe("Math.floor", () => {
    it("lowers Math.floor to modulo math while keeping the infinity guard", () => {
      const lua = compile("declare const x: number; const a = Math.floor(x);");
      expect(lua).toContain("% 1");
      expect(lua).toContain("math.floor(x)");
    });

    it("keeps math.floor when argument has side effects", () => {
      const lua = compile("declare function foo(): number; const a = Math.floor(foo());");
      expect(lua).toContain("math.floor");
    });

    it("keeps math.floor when argument is a property access that could invoke a getter", () => {
      const lua = compile(`
        declare const box: { readonly value: number };
        const a = Math.floor(box.value);
      `);

      expect(lua).toContain("math.floor");
    });

    it("keeps math.floor for Infinity to preserve Lua math.floor semantics", () => {
      const lua = compile("const a = Math.floor(Infinity);");

      expect(lua).toContain("math.floor");
    });

    it("keeps math.floor for oversized numeric literals that become non-finite", () => {
      const lua = compile("const a = Math.floor(1e309);");

      expect(lua).toContain("math.floor");
      expect(lua).not.toContain("= Infinity");
    });

    it("does not rewrite user receivers that are only typed as Math", () => {
      const lua = compile(`
        const myMath = ({ floor(x: number) { return x + 100; } } as unknown) as Math;
        const y = myMath.floor(1.2);
      `);

      expect(lua).toContain("myMath:floor(1.2)");
      expect(lua).not.toContain("math.floor");
    });
  });

  describe("Math.sqrt", () => {
    it("replaces with x ^ 0.5 when argument is pure", () => {
      const lua = compile("declare const x: number; const a = Math.sqrt(x);");
      expect(lua).toContain("x ^ 0.5");
      expect(lua).not.toContain("math.sqrt");
    });

    it("replaces even when argument has side effects (single use)", () => {
      const lua = compile("declare function foo(): number; const a = Math.sqrt(foo());");

      expect(lua).toContain("foo() ^ 0.5");
      expect(countOccurrences(lua, "foo()")).toBe(1);
      expect(lua).not.toContain("math.sqrt");
    });
  });

  describe("Math.abs", () => {
    it("replaces with conditional when argument is pure", () => {
      const lua = compile("declare const x: number; const a = Math.abs(x);");
      expect(lua).not.toContain("math.abs");
      expect(lua).toContain("x < 0");
    });

    it("parenthesizes negation to avoid Lua comment syntax", () => {
      const noFold = { pluginOptions: { rules: { "constant-folding": false } } };

      const lua = compile("const x = Math.abs(-42);", noFold);

      expect(lua).toContain("-(-42)");
      expect(lua).not.toMatch(/--\d/);
    });

    it("keeps math.abs when argument has side effects", () => {
      const lua = compile("declare function foo(): number; const a = Math.abs(foo());");
      expect(lua).toContain("math.abs");
    });

    it("keeps math.abs when argument is a property access that could invoke a getter", () => {
      const lua = compile(`
        declare const box: { readonly value: number };
        const a = Math.abs(box.value);
      `);

      expect(lua).toContain("math.abs");
    });

    it("normalizes negative zero to zero", () => {
      const lua = normalizeLua(
        compile("const x = Math.abs(-0);", {
          pluginOptions: { rules: { "constant-folding": false } },
        }),
      );

      expect(lua).toContain("== 0");
      expect(lua).not.toContain("math.abs");
    });
  });

  describe("generated AST ownership", () => {
    type VisitorTestContext = {
      transformExpression(): tstl.Expression;
    };
    const checker = {
      getSymbolAtLocation: () => ({}),
      getTypeOfSymbol: () => ({}),
      typeToString: () => "Math",
    };
    const config = {
      target: "puc",
    };
    const context = {
      transformExpression: () =>
        tstl.createBinaryExpression(
          tstl.createIdentifier("lhs"),
          tstl.createIdentifier("rhs"),
          tstl.SyntaxKind.AdditionOperator,
        ),
    };

    it.each([
      { method: "abs", source: "Math.abs(value);" },
      { method: "floor", source: "Math.floor(value);" },
    ])("does not alias repeated Lua subtrees for Math.$method", ({ source }) => {
      const visitors = Reflect.apply(createVisitors, undefined, [checker, config]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.CallExpression,
        context: VisitorTestContext,
      ) => tstl.Expression;
      const expression = Reflect.apply(visitor, undefined, [parseCallExpression(source), context]);
      const refs = collectExpressionReferences(expression);

      expect(new Set(refs).size).toBe(refs.length);
    });
  });

  describe.each([
    { name: "Math.max", method: "max" },
    { name: "Math.min", method: "min" },
  ])("$name", ({ method }) => {
    it.each([
      {
        name: "arguments can be NaN",
        template: (mathMethod: string) =>
          `declare const a: number; declare const b: number; const c = Math.${mathMethod}(a, b);`,
      },
      {
        name: "3+ arguments are present",
        template: (mathMethod: string) =>
          `declare const a: number; declare const b: number; declare const c: number; const d = Math.${mathMethod}(a, b, c);`,
      },
      {
        name: "any argument has side effects",
        template: (mathMethod: string) =>
          `declare function foo(): number; declare const b: number; const c = Math.${mathMethod}(foo(), b);`,
      },
    ])("keeps math.$method when $name", ({ template }) => {
      const lua = compile(template(method));

      expect(lua).toContain(`math.${method}`);
    });
  });

  describe("x ** 2", () => {
    it.each([
      {
        name: "replaces x ** 2 when base is pure",
        source: "declare const x: number; const a = x ** 2;",
        contains: ["x * x"],
        excludes: ["^"],
      },
      {
        name: "keeps x ^ 2 when base has side effects",
        source: "declare function foo(): number; const a = foo() ** 2;",
        contains: ["^ 2"],
      },
      {
        name: "does not replace x ** 3 or other exponents",
        source: "declare const x: number; const a = x ** 3;",
        contains: ["x ^ 3"],
      },
      {
        name: "keeps element-access bases to avoid duplicating indexed reads",
        source: "declare const arr: number[]; const a = arr[0] ** 2;",
        contains: ["^ 2"],
      },
    ])("$name", ({ source, contains, excludes }) => {
      const lua = compile(source);

      expectLuaSnippets(lua, { contains, excludes });
    });
  });

  describe("constant-folding interaction", () => {
    it("folds Math.floor with constant argument to literal", () => {
      const lua = compile("const x = Math.floor(1.7);");

      expect(lua).toContain("= 1");
      expect(lua).not.toContain("% 1");
      expect(lua).not.toContain("math.floor");
    });

    it("folds Math.abs conditional with constant argument", () => {
      const lua = compile("const x = Math.abs(-42);");

      expect(lua).toContain("true and");
      expect(lua).not.toContain("math.abs");
      expect(lua).not.toMatch(/--\d/);
    });

    it("folds Math.max conditional with constant arguments", () => {
      const lua = compile("const x = Math.max(5, 3);");

      expect(lua).toContain("true and 5 or 3");
      expect(lua).not.toContain("math.max");
    });

    it("folds x ** 2 with constant base to literal", () => {
      const lua = compile("const x = 3 ** 2;");

      expect(lua).toContain("= 9");
    });
  });

  describe("passthrough", () => {
    it("does not transform non-Math calls", () => {
      const lua = compile("declare function floor(x: number): number; const a = floor(1.5);");
      expect(lua).toContain("floor(1.5)");
    });

    it("does not transform unsupported Math methods", () => {
      const lua = compile("declare const x: number; const a = Math.ceil(x);");
      expect(lua).toContain("math.ceil");
    });
  });

  describe("luajit target", () => {
    const jit = { pluginOptions: { target: "luajit" as const } };

    it.each([
      {
        name: "skips floor transform",
        source: "declare const x: number; const a = Math.floor(x);",
        contains: ["math.floor"],
      },
      {
        name: "skips sqrt transform",
        source: "declare const x: number; const a = Math.sqrt(x);",
        contains: ["math.sqrt"],
      },
      {
        name: "skips abs transform",
        source: "declare const x: number; const a = Math.abs(x);",
        contains: ["math.abs"],
      },
      {
        name: "skips max transform",
        source: "declare const a: number; declare const b: number; const c = Math.max(a, b);",
        contains: ["math.max"],
      },
      {
        name: "skips min transform",
        source: "declare const a: number; declare const b: number; const c = Math.min(a, b);",
        contains: ["math.min"],
      },
      {
        name: "still applies x ** 2 → x * x",
        source: "declare const x: number; const a = x ** 2;",
        contains: ["x * x"],
        excludes: ["^"],
      },
    ])("$name on LuaJIT", ({ source, contains, excludes }) => {
      const lua = compile(source, jit);
      expectLuaSnippets(lua, { contains, excludes });
    });
  });
});
