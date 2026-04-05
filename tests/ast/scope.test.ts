// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { walkStatements } from "../../src/ast/lua-walker";
import { buildChainExpression, collectScopeInfo, luaPropertyChain } from "../../src/ast/scope";

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
  if (!tstl.isTableIndexExpression(expr)) throw new Error("Expected TableIndexExpression");
  return expr;
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

describe("collectScopeInfo", () => {
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

    const { chainCounts } = collectScopeInfo(statements, false);
    expect(chainCounts.get("math.cos")).toBe(2);
    expect(chainCounts.get("math.sin")).toBe(1);
  });

  it("returns empty results for empty statement list", () => {
    const { chainCounts, scopeDefs } = collectScopeInfo([], false);
    expect(chainCounts.size).toBe(0);
    expect(scopeDefs.size).toBe(0);
  });

  it("does not double-count sub-chains", () => {
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

    const { chainCounts } = collectScopeInfo(statements, false);
    expect(chainCounts.get("math.floor")).toBe(2);
    expect(chainCounts.has("math")).toBe(false);
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

    const { chainCounts } = collectScopeInfo(statements, false);
    expect(chainCounts.get("math.cos")).toBe(1);
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

    const { chainCounts } = collectScopeInfo(statements, true);
    expect(chainCounts.has("math.cos")).toBe(false);
  });

  it("collects variable declaration LHS identifiers as scopeDefs", () => {
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("x"),
        tstl.createNumericLiteral(1),
      ),
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("y"),
        tstl.createNumericLiteral(2),
      ),
    ];

    const { scopeDefs } = collectScopeInfo(statements, false);
    expect(scopeDefs).toStrictEqual(new Set(["x", "y"]));
  });

  it("collects assignment LHS identifiers as scopeDefs", () => {
    const statements: tstl.Statement[] = [
      tstl.createAssignmentStatement(tstl.createIdentifier("a"), tstl.createNumericLiteral(10)),
    ];

    const { scopeDefs } = collectScopeInfo(statements, false);
    expect(scopeDefs).toStrictEqual(new Set(["a"]));
  });

  it("collects scopeDefs inside nested blocks when shallow=false", () => {
    const innerStatements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("inner"),
        tstl.createNumericLiteral(1),
      ),
    ];
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("outer"),
        tstl.createNumericLiteral(0),
      ),
      tstl.createDoStatement(innerStatements),
    ];

    const { scopeDefs } = collectScopeInfo(statements, false);
    expect(scopeDefs).toStrictEqual(new Set(["outer", "inner"]));
  });

  it("skips scopeDefs inside function bodies when shallow=true", () => {
    const funcBody = tstl.createBlock([
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("inner"),
        tstl.createNumericLiteral(1),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const statements: tstl.Statement[] = [
      tstl.createVariableDeclarationStatement(tstl.createIdentifier("fn"), funcExpr),
    ];

    const { scopeDefs } = collectScopeInfo(statements, true);
    expect(scopeDefs).toStrictEqual(new Set(["fn"]));
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
    expect(luaPropertyChain(buildChainExpression("math.cos"))).toBe("math.cos");
    expect(luaPropertyChain(buildChainExpression("a.b.c.d"))).toBe("a.b.c.d");
    expect(luaPropertyChain(buildChainExpression("os.clock"))).toBe("os.clock");
  });

  it("throws for single-segment chain", () => {
    expect(() => buildChainExpression("math")).toThrow("dotted chain");
  });
});
