import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  classifyCrossModuleFreeVariables,
  hasCrossModuleFreeVariable,
  isDescendant,
} from "../../../../src/rules/inline/cross-module";
import { findNode, makeChecker, makeMultiFileChecker } from "../helpers";

type DescendantNodeKey = "functionDeclaration" | "returnStatement";

function findFunction(sourceFile: ts.SourceFile, name = "fn"): ts.FunctionDeclaration {
  const declaration = findNode(
    sourceFile,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration?.body) throw new Error(`expected ${name} body`);
  return declaration;
}

describe("isDescendant", () => {
  it.each<{
    ancestor: DescendantNodeKey;
    descendant: DescendantNodeKey;
    expected: boolean;
    name: string;
  }>([
    {
      name: "return statement inside function declaration",
      descendant: "returnStatement",
      ancestor: "functionDeclaration",
      expected: true,
    },
    {
      name: "function declaration inside return statement",
      descendant: "functionDeclaration",
      ancestor: "returnStatement",
      expected: false,
    },
  ])("returns $expected for $name", ({ ancestor, descendant, expected }) => {
    const { sourceFile } = makeChecker("function fn() { const x = 1; return x; }");
    const fn = findFunction(sourceFile);
    const returnStatement = findNode(fn, ts.isReturnStatement);
    if (!returnStatement) throw new Error("expected return statement");
    const nodes: Record<DescendantNodeKey, ts.Node> = {
      functionDeclaration: fn,
      returnStatement,
    };

    expect(isDescendant(nodes[descendant], nodes[ancestor])).toBe(expected);
  });
});

describe("hasCrossModuleFreeVariable", () => {
  it.each<{
    expected: boolean;
    name: string;
    selectNodes: (fn: ts.FunctionDeclaration) => readonly ts.Node[];
    source: string;
  }>([
    {
      name: "only parameters and locals",
      expected: false,
      source: "function fn(value: number): number { const next = value + 1; return next; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "an empty node list",
      expected: false,
      source: "function fn(): number { return 1; }",
      selectNodes: () => [],
    },
    {
      name: "type nodes",
      expected: false,
      source: "function fn(value: number): number { return value; }",
      selectNodes: () => [ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)],
    },
    {
      name: "same-file free variables",
      expected: true,
      source: "let LEFT = 1; let RIGHT = 2; function fn(): number { return LEFT + RIGHT; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "property receivers",
      expected: true,
      source: "const box = { value: 1 }; function fn(): number { return box.value; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "element access expressions",
      expected: true,
      source: "const arr = [1, 2, 3]; function fn(): number { return arr[0]; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "property assignments with same-file identifiers",
      expected: true,
      source: "let value = 42; function fn(): object { return { value: value }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "shorthand property assignments with same-file identifiers",
      expected: true,
      source: "let moduleVar = 10; function fn(): object { return { moduleVar }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "computed property names with same-file variable",
      expected: true,
      source: "let key = 'myKey'; function fn(): object { return { [key]: 42 }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "type nodes in element access",
      expected: false,
      source: "function fn(arr: any[]): any { return arr[0]; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "property access on non-identifier receiver",
      expected: false,
      source: "function fn(obj: any): any { return (obj as any).prop; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "chained method call receiver (non-identifier after unwrap)",
      expected: false,
      source:
        "function fn(obj: { method(): { value: number } }): number { return obj.method().value; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "shorthand property with same-file identifier",
      expected: true,
      source: "let localVar = 5; function fn(): object { return { localVar }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "shorthand property without object assignment initializer",
      expected: false,
      source: "const x = 1; function fn(param: typeof x): object { return { param }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "ambient global (Math)",
      expected: false,
      source: "function fn(x: number) { return Math.floor(x); }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
  ])("hasCrossModuleFreeVariable returns $expected for $name", ({
    expected,
    selectNodes,
    source,
  }) => {
    const { checker, sourceFile } = makeChecker(source);
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(selectNodes(fn), fn.parameters, fn, checker)).toBe(expected);
  });

  it.each<{ name: string; files: Record<string, string> }>([
    {
      name: "aliased imports",
      files: {
        "constants.ts": "export const LIMIT = 1;",
        "test.ts": `
          import { LIMIT } from "./constants";

          function fn(): number {
            return LIMIT;
          }
        `,
      },
    },
    {
      name: "cross-module free variables in computed property names",
      files: {
        "keys.ts": "export const KEY = 'myKey';",
        "test.ts": `
          import { KEY } from "./keys";

          function fn(): object {
            return { [KEY]: 42 };
          }
        `,
      },
    },
    {
      name: "cross-module free variables in element access expressions",
      files: {
        "arrays.ts": "export const ARR = [1, 2, 3];",
        "test.ts": `
          import { ARR } from "./arrays";

          function fn(): number {
            return ARR[0];
          }
        `,
      },
    },
    {
      name: "cross-module free variables in object spread initializers",
      files: {
        "objects.ts": "export const obj = { x: 1 };",
        "test.ts": `
            import { obj } from "./objects";

            function fn(): object {
              const enhanced = { ...obj, y: 2 };
              return enhanced;
            }
          `,
      },
    },
    {
      name: "aliased cross-module identifiers through type assertions",
      files: {
        "constants.ts": "export const LIMIT = 100;",
        "test.ts": `
          import { LIMIT as MAX } from "./constants";

          function fn(): number {
            return MAX as any;
          }
        `,
      },
    },
    {
      name: "aliased cross-module identifiers",
      files: {
        "constants.ts": "export const LIMIT = 100;",
        "test.ts": `
          import { LIMIT as MAX } from "./constants";

          function fn(): number {
            return MAX;
          }
        `,
      },
    },
    {
      name: "aliased identifiers in shorthand property assignments",
      files: {
        "constants.ts": "export const VALUE = 42;",
        "test.ts": `
          import { VALUE as VAL } from "./constants";

          function fn(): object {
            return { VAL };
          }
        `,
      },
    },
    {
      name: "aliased property access on cross-module exports",
      files: {
        "constants.ts": "export const CONFIG = { limit: 100 };",
        "test.ts": `
          import { CONFIG as CFG } from "./constants";

          function fn(): number {
            return CFG.limit;
          }
        `,
      },
    },
  ])("detects $name", ({ files }) => {
    const { checker, sourceFile } = makeMultiFileChecker(files, "test.ts");
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects cross-module variables in destructured parameter defaults", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "shared.ts": "export const enhanced = { x: 2 };",
        "test.ts": `
            import { enhanced } from "./shared";

            function fn({ shared = enhanced }: any = {}): any {
              return shared;
            }
          `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);
    const params = fn.parameters;

    expect(hasCrossModuleFreeVariable(params, [], fn, checker)).toBe(true);
  });
});

describe("classifyCrossModuleFreeVariables", () => {
  it("blocks synthetic identifiers without checker symbols", () => {
    const { checker, sourceFile } = makeChecker("function fn(): void {}");
    const fn = findFunction(sourceFile);
    const propertyAccess = ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("MISSING"),
      "value",
    );
    const shorthand = ts.factory.createShorthandPropertyAssignment(
      ts.factory.createIdentifier("MISSING"),
      ts.factory.createNumericLiteral("1"),
    );

    const result = classifyCrossModuleFreeVariables(
      [propertyAccess, shorthand, ts.factory.createIdentifier("MISSING")],
      fn.parameters,
      fn,
      checker,
    );

    expect(result.blocking.map((node) => node.text)).toStrictEqual([
      "MISSING",
      "MISSING",
      "MISSING",
    ]);
    expect(result.substitutions.size).toBe(0);
  });

  it("ambient global is not blocking and not substituted", () => {
    const { checker, sourceFile } = makeChecker("function fn(x: number) { return Math.floor(x); }");
    const fn = findFunction(sourceFile);

    const result = classifyCrossModuleFreeVariables(
      fn.body?.statements ?? [],
      fn.parameters,
      fn,
      checker,
    );

    expect(result.blocking).toStrictEqual([]);
    expect(result.substitutions.size).toBe(0);
  });

  it("substitutes non-exported same-file const literal", () => {
    const { checker, sourceFile } = makeChecker(
      'const MSG = "boom"; function fn(): string { return MSG; }',
    );
    const fn = findFunction(sourceFile);

    const result = classifyCrossModuleFreeVariables(
      fn.body?.statements ?? [],
      fn.parameters,
      fn,
      checker,
    );

    expect(result.blocking).toStrictEqual([]);
    expect(result.substitutions.size).toBe(1);
  });

  it("blocks non-const same-file variable", () => {
    const { checker, sourceFile } = makeChecker(
      "let counter = 0; function fn(): number { return counter; }",
    );
    const fn = findFunction(sourceFile);

    const result = classifyCrossModuleFreeVariables(
      fn.body?.statements ?? [],
      fn.parameters,
      fn,
      checker,
    );

    expect(result.blocking).toHaveLength(1);
    expect(result.substitutions.size).toBe(0);
  });
});
