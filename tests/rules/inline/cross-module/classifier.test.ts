import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  classifyCrossModuleFreeVariables,
  hasCrossModuleFreeVariable,
  isDescendant,
} from "../../../../src/rules/inline/cross-module";
import { findNode, makeChecker, makeMultiFileChecker } from "../helpers";

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
  it("detects descendant relationships", () => {
    const { sourceFile } = makeChecker("function fn() { const x = 1; return x; }");
    const fn = findFunction(sourceFile);
    const returnStatement = findNode(fn, ts.isReturnStatement);
    if (!returnStatement) throw new Error("expected return statement");

    expect(isDescendant(returnStatement, fn)).toBe(true);
    expect(isDescendant(fn, returnStatement)).toBe(false);
  });
});

describe("classifyCrossModuleFreeVariables", () => {
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
      source: "const LEFT = 1; const RIGHT = 2; function fn(): number { return LEFT + RIGHT; }",
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
      source: "const value = 42; function fn(): object { return { value: value }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "shorthand property assignments with same-file identifiers",
      expected: true,
      source: "const moduleVar = 10; function fn(): object { return { moduleVar }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "computed property names with same-file variable",
      expected: true,
      source: "const key = 'myKey'; function fn(): object { return { [key]: 42 }; }",
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
      name: "shorthand property with same-file identifier",
      expected: true,
      source: "const localVar = 5; function fn(): object { return { localVar }; }",
      selectNodes: (fn) => fn.body?.statements ?? [],
    },
    {
      name: "shorthand property without object assignment initializer",
      expected: false,
      source: "const x = 1; function fn(param: typeof x): object { return { param }; }",
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

  it("detects aliased imports when checking free variables", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "constants.ts": "export const LIMIT = 1;",
        "test.ts": `
          import { LIMIT } from "./constants";

          function fn(): number {
            return LIMIT;
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("walks synthetic nodes without checker symbols", () => {
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

    expect(result.blocking).toHaveLength(0);
    expect(result.substitutions.size).toBe(0);
  });

  it("detects cross-module free variables in computed property names", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "keys.ts": "export const KEY = 'myKey';",
        "test.ts": `
          import { KEY } from "./keys";

          function fn(): object {
            return { [KEY]: 42 };
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects cross-module free variables in element access expressions", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "arrays.ts": "export const ARR = [1, 2, 3];",
        "test.ts": `
          import { ARR } from "./arrays";

          function fn(): number {
            return ARR[0];
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects cross-module free variables in shorthand property with object assignment initializer", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "objects.ts": "export const obj = { x: 1 };",
        "test.ts": `
            import { obj } from "./objects";

            function fn(): object {
              const enhanced = { ...obj, y: 2 };
              return enhanced;
            }
          `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects cross-module aliased symbols in property access", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "constants.ts": "export const LIMIT = 100;",
        "test.ts": `
          import { LIMIT as MAX } from "./constants";

          function fn(): number {
            return MAX as any;
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects aliased property access on cross-module identifiers", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "constants.ts": "export const LIMIT = 100;",
        "test.ts": `
          import { LIMIT as MAX } from "./constants";

          function fn(): number {
            return MAX;
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects aliased identifiers in shorthand property assignments", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "constants.ts": "export const VALUE = 42;",
        "test.ts": `
          import { VALUE as VAL } from "./constants";

          function fn(): object {
            return { VAL };
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects aliased property access on cross-module exports", () => {
    const { checker, sourceFile } = makeMultiFileChecker(
      {
        "constants.ts": "export const CONFIG = { limit: 100 };",
        "test.ts": `
          import { CONFIG as CFG } from "./constants";

          function fn(): number {
            return CFG.limit;
          }
        `,
      },
      "test.ts",
    );
    const fn = findFunction(sourceFile);

    expect(hasCrossModuleFreeVariable(fn.body?.statements ?? [], fn.parameters, fn, checker)).toBe(
      true,
    );
  });

  it("detects cross-module variables in function parameters with shorthand property defaults", () => {
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
