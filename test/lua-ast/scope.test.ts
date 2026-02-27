// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { walkStatements } from "../../src/lua-ast/lua-walker";
import { buildChainExpression, collectChains, luaPropertyChain } from "../../src/lua-ast/scope";

function countPropertyAccess(statements: tstl.Statement[], chain: string): number {
  let count = 0;
  walkStatements(statements, {
    expr: (expr) => {
      if (tstl.isTableIndexExpression(expr)) {
        const repr = luaPropertyChain(expr);
        if (repr === chain) count++;
      }
    },
  });
  return count;
}

// Helper: build `table.field` as a Lua TableIndexExpression
function makeAccess(table: string, ...fields: string[]): tstl.TableIndexExpression {
  let expr: tstl.Expression = tstl.createIdentifier(table);
  for (const field of fields) {
    expr = tstl.createTableIndexExpression(expr, tstl.createStringLiteral(field));
  }
  return expr as tstl.TableIndexExpression;
}

describe("luaPropertyChain", () => {
  it("returns dotted chain for string-keyed access at any depth", () => {
    expect(luaPropertyChain(makeAccess("math", "cos"))).toBe("math.cos");
    expect(luaPropertyChain(makeAccess("config", "graphics", "width"))).toBe(
      "config.graphics.width",
    );
  });

  it("returns undefined for numeric index at any position", () => {
    const directNumeric = tstl.createTableIndexExpression(
      tstl.createIdentifier("arr"),
      tstl.createNumericLiteral(1),
    );
    expect(luaPropertyChain(directNumeric)).toBeUndefined();

    // arr[1].field — intermediate numeric breaks the chain
    const nestedNumeric = tstl.createTableIndexExpression(
      directNumeric,
      tstl.createStringLiteral("field"),
    );
    expect(luaPropertyChain(nestedNumeric)).toBeUndefined();
  });

  it("returns undefined when base is not an identifier", () => {
    const call = tstl.createCallExpression(tstl.createIdentifier("foo"), []);
    const node = tstl.createTableIndexExpression(call, tstl.createStringLiteral("bar"));
    expect(luaPropertyChain(node)).toBeUndefined();
  });
});

describe("countPropertyAccess", () => {
  it("counts matching chains at any depth", () => {
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        makeAccess("math", "cos"),
      ),
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("y"),
        makeAccess("math", "cos"),
      ),
    ];

    expect(countPropertyAccess(statements, "math.cos")).toBe(2);

    // Deep chain: config.graphics.width
    const deep: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("w"),
        makeAccess("config", "graphics", "width"),
      ),
    ];
    expect(countPropertyAccess(deep, "config.graphics.width")).toBe(1);
  });

  it("returns zero for empty list or non-matching chains", () => {
    expect(countPropertyAccess([], "math.cos")).toBe(0);

    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        makeAccess("math", "sin"),
      ),
    ];
    expect(countPropertyAccess(statements, "math.cos")).toBe(0);
  });

  it("counts nested property accesses inside expressions", () => {
    const posX1 = makeAccess("positions", "x");
    const posX2 = makeAccess("positions", "x");
    const idx1 = tstl.createTableIndexExpression(posX1, tstl.createIdentifier("i"));
    const idx2 = tstl.createTableIndexExpression(posX2, tstl.createIdentifier("j"));
    const add = tstl.createBinaryExpression(idx1, idx2, tstl.SyntaxKind.AdditionOperator);
    const statements: tstl.Statement[] = [
      tstl.createAssignmentStatement(tstl.createIdentifier("x"), add),
    ];

    expect(countPropertyAccess(statements, "positions.x")).toBe(2);
  });
});

describe("collectChains", () => {
  it("collects chains with correct counts", () => {
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("a"),
        makeAccess("math", "cos"),
      ),
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("b"),
        makeAccess("math", "cos"),
      ),
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("c"),
        makeAccess("math", "sin"),
      ),
    ];

    const result = collectChains(statements, false);
    expect(result.get("math.cos")).toBe(2);
    expect(result.get("math.sin")).toBe(1);
  });

  it("returns empty map for empty statement list", () => {
    expect(collectChains([], false).size).toBe(0);
  });

  it("does not double-count sub-chains", () => {
    // math.floor should be counted, but not "math" as a separate sub-chain
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        makeAccess("math", "floor"),
      ),
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("y"),
        makeAccess("math", "floor"),
      ),
    ];

    const result = collectChains(statements, false);
    expect(result.get("math.floor")).toBe(2);
    expect(result.has("math")).toBe(false);
  });

  it("counts chains inside function bodies when shallow=false", () => {
    const funcBody = tstl.createBlock([
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        makeAccess("math", "cos"),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(tstl.createIdentifier("fn"), funcExpr),
    ];

    const deep = collectChains(statements, false);
    expect(deep.get("math.cos")).toBe(1);
  });

  it("skips function bodies when shallow=true", () => {
    const funcBody = tstl.createBlock([
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        makeAccess("math", "cos"),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(tstl.createIdentifier("fn"), funcExpr),
    ];

    const shallow = collectChains(statements, true);
    expect(shallow.has("math.cos")).toBe(false);
  });
});

describe("buildChainExpression", () => {
  it("builds a two-segment chain", () => {
    const expr = buildChainExpression("math.floor");
    expect(tstl.isTableIndexExpression(expr)).toBe(true);
    expect(luaPropertyChain(expr)).toBe("math.floor");
  });

  it("builds a three-segment chain", () => {
    const expr = buildChainExpression("config.graphics.width");
    expect(tstl.isTableIndexExpression(expr)).toBe(true);
    expect(luaPropertyChain(expr)).toBe("config.graphics.width");
  });

  it("round-trips with luaPropertyChain", () => {
    for (const chain of ["math.cos", "a.b.c.d", "os.clock"]) {
      expect(luaPropertyChain(buildChainExpression(chain))).toBe(chain);
    }
  });
});
