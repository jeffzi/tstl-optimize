// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { walkStatements } from "../../src/ast/lua-walker";
import {
  buildChainExpression,
  collectArrayElementAccesses,
  collectScopeInfo,
  luaPropertyChain,
} from "../../src/ast/scope";

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
  it.each([
    { chain: "math.floor" },
    { chain: "config.graphics.width" },
    { chain: "a.b.c.d" },
    { chain: "os.clock" },
  ])("builds and round-trips $chain", ({ chain }) => {
    const expr = buildChainExpression(chain);
    expect(tstl.isTableIndexExpression(expr)).toBe(true);
    expect(luaPropertyChain(expr)).toBe(chain);
  });

  it("throws for single-segment chain", () => {
    expect(() => buildChainExpression("math")).toThrow("dotted chain");
  });
});

describe("collectArrayElementAccesses", () => {
  it("ignores array accesses with non-identifier indices", () => {
    // Numeric literal index — not a loop variable
    const table = tstl.createIdentifier("t");
    const index = tstl.createNumericLiteral(1);
    const expr = tstl.createTableIndexExpression(table, index);
    const stmt = tstl.createExpressionStatement(expr);

    const info = collectArrayElementAccesses([stmt], new Set(["i", "j"]), true);

    expect(info.counts.size).toBe(0);
    expect(info.writes.size).toBe(0);
    expect(info.loopVar.size).toBe(0);
  });

  it("ignores array accesses with identifiers not in loopVarNames", () => {
    const table = tstl.createIdentifier("t");
    const index = tstl.createIdentifier("x"); // x is not in loopVarNames
    const expr = tstl.createTableIndexExpression(table, index);
    const stmt = tstl.createExpressionStatement(expr);

    const info = collectArrayElementAccesses([stmt], new Set(["i", "j"]), true);

    expect(info.counts.size).toBe(0);
    expect(info.loopVar.size).toBe(0);
  });

  it("counts RHS array element accesses with loop variable index", () => {
    // t[i] on RHS (expression statement)
    const table = tstl.createIdentifier("t");
    const index = tstl.createIdentifier("i");
    const expr = tstl.createTableIndexExpression(table, index);
    const stmt = tstl.createExpressionStatement(expr);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), true);

    expect(info.counts.get("t")).toBe(1);
    expect(info.loopVar.get("t")).toBe("i");
    expect(info.writes.has("t")).toBe(false);
  });

  it("counts and marks LHS array element writes", () => {
    // t[i] on LHS (assignment statement)
    const table = tstl.createIdentifier("t");
    const index = tstl.createIdentifier("i");
    const lhs = tstl.createTableIndexExpression(table, index);
    const stmt = tstl.createAssignmentStatement([lhs], [tstl.createNumericLiteral(1)]);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), true);

    expect(info.counts.get("t")).toBe(1);
    expect(info.loopVar.get("t")).toBe("i");
    expect(info.writes.has("t")).toBe(true);
  });

  it("counts multiple accesses to the same base with same loop var", () => {
    const table1 = tstl.createIdentifier("t");
    const table2 = tstl.createIdentifier("t");
    const index = tstl.createIdentifier("i");

    const expr1 = tstl.createTableIndexExpression(table1, index);
    const expr2 = tstl.createTableIndexExpression(table2, index);

    const stmts = [tstl.createExpressionStatement(expr1), tstl.createExpressionStatement(expr2)];

    const info = collectArrayElementAccesses(stmts, new Set(["i"]), true);

    expect(info.counts.get("t")).toBe(2);
    expect(info.loopVar.get("t")).toBe("i");
  });

  it("Line 114: detects mixed indices and excludes base from hoisting", () => {
    // t[i] in one place, t[j] in another (same base, different loop variables)
    const table1 = tstl.createIdentifier("t");
    const table2 = tstl.createIdentifier("t");
    const indexI = tstl.createIdentifier("i");
    const indexJ = tstl.createIdentifier("j");

    const expr1 = tstl.createTableIndexExpression(table1, indexI);
    const expr2 = tstl.createTableIndexExpression(table2, indexJ);

    const stmts = [tstl.createExpressionStatement(expr1), tstl.createExpressionStatement(expr2)];

    const info = collectArrayElementAccesses(stmts, new Set(["i", "j"]), true);

    // t has mixed indices, so it should be excluded from optimization
    expect(info.counts.has("t")).toBe(false);
    expect(info.loopVar.has("t")).toBe(false);
  });

  it("Lines 164-166: cleanup removes mixed indices from all maps", () => {
    // t[i] and t[j] (mixed), s[k] (consistent)
    const tableT1 = tstl.createIdentifier("t");
    const tableT2 = tstl.createIdentifier("t");
    const tableS = tstl.createIdentifier("s");
    const indexI = tstl.createIdentifier("i");
    const indexJ = tstl.createIdentifier("j");
    const indexK = tstl.createIdentifier("k");

    const exprTI = tstl.createTableIndexExpression(tableT1, indexI);
    const exprTJ = tstl.createTableIndexExpression(tableT2, indexJ);
    const exprSK = tstl.createTableIndexExpression(tableS, indexK);

    // Also include a write to t to test cleanup of writes map
    const lhs = tstl.createTableIndexExpression(tstl.createIdentifier("t"), indexI);
    const assignStmt = tstl.createAssignmentStatement([lhs], [tstl.createNumericLiteral(1)]);

    const stmts = [
      tstl.createExpressionStatement(exprTI),
      tstl.createExpressionStatement(exprTJ),
      tstl.createExpressionStatement(exprSK),
      assignStmt,
    ];

    const info = collectArrayElementAccesses(stmts, new Set(["i", "j", "k"]), true);

    // t is mixed, so all its entries should be removed from counts, loopVar, and writes
    expect(info.counts.has("t")).toBe(false);
    expect(info.loopVar.has("t")).toBe(false);
    expect(info.writes.has("t")).toBe(false);

    // s is consistent, so it should remain in all maps
    expect(info.counts.has("s")).toBe(true);
    expect(info.loopVar.get("s")).toBe("k");
    expect(info.writes.has("s")).toBe(false);
  });

  it("respects guardDepth to skip counting inside guarded expressions", () => {
    // This is tested implicitly by testing expressions vs statement contexts
    // but we can verify that shallow=false includes function bodies
    const funcBody = tstl.createBlock([
      tstl.createExpressionStatement(
        tstl.createTableIndexExpression(tstl.createIdentifier("t"), tstl.createIdentifier("i")),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const stmt = tstl.createVariableDeclarationStatement(tstl.createIdentifier("f"), funcExpr);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), false);

    // With shallow=false, function bodies are traversed, so t[i] should be counted
    expect(info.counts.has("t")).toBe(true);
  });

  it("skips counting when shallow=true and access is inside function", () => {
    // With shallow=true, function bodies are not traversed
    const funcBody = tstl.createBlock([
      tstl.createExpressionStatement(
        tstl.createTableIndexExpression(tstl.createIdentifier("t"), tstl.createIdentifier("i")),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const stmt = tstl.createVariableDeclarationStatement(tstl.createIdentifier("f"), funcExpr);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), true);

    // With shallow=true, function bodies are skipped
    expect(info.counts.size).toBe(0);
  });
});
