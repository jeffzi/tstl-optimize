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

describe("when counting property chain occurrences in statements", () => {
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

  it.each([
    { shallow: false, expectedCount: 1, description: "includes function bodies" },
    { shallow: true, expectedCount: 0, description: "skips function bodies" },
  ])("chain counting $description", ({ shallow, expectedCount }) => {
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

    const { chainCounts } = collectScopeInfo(statements, shallow);
    expect(chainCounts.get("math.cos") ?? 0).toBe(expectedCount);
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

  it("does NOT collect nested function expression parameters as scopeDefs (they belong to nested scope)", () => {
    const funcBody = tstl.createBlock([
      tstl.createReturnStatement([makeAccess("config", "timeout")]),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, [tstl.createIdentifier("config")]);
    const callExpr = tstl.createCallExpression(funcExpr, [tstl.createIdentifier("config")]);
    const statements: tstl.Statement[] = [tstl.createExpressionStatement(callExpr)];

    const { scopeDefs } = collectScopeInfo(statements, false);
    // Nested function parameters belong to the nested scope and should NOT be in the outer scope's scopeDefs
    expect(scopeDefs).toStrictEqual(new Set([]));
  });

  it("collects chained assignment targets, loop variables (but not nested function params)", () => {
    const functionDefinition = tstl.createAssignmentStatement(
      makeAccess("module", "run"),
      tstl.createFunctionExpression(tstl.createBlock([]), [tstl.createIdentifier("config")]),
    );
    const propertyAssignment = tstl.createAssignmentStatement(
      makeAccess("state", "value"),
      tstl.createNumericLiteral(1),
    );
    const forIn = tstl.createForInStatement(
      tstl.createBlock([]),
      [tstl.createIdentifier("key")],
      [tstl.createIdentifier("pairsIter")],
    );
    const forStmt = tstl.createForStatement(
      tstl.createBlock([]),
      tstl.createIdentifier("i"),
      tstl.createNumericLiteral(0),
      tstl.createNumericLiteral(1),
    );

    const { scopeDefs } = collectScopeInfo(
      [functionDefinition, propertyAssignment, forIn, forStmt],
      false,
    );

    // NOTE: "config" is a parameter of the nested function, so it should NOT be in module-level scopeDefs
    expect(scopeDefs).toStrictEqual(new Set(["module.run", "state.value", "key", "i"]));
  });

  it("ignores TableIndexExpression LHS when property chain is non-string-keyed", () => {
    // t[1] = 0 — numeric index → luaPropertyChain returns undefined → not added to scopeDefs
    const numericLhs = tstl.createTableIndexExpression(
      tstl.createIdentifier("t"),
      tstl.createNumericLiteral(1),
    );
    const stmt = tstl.createAssignmentStatement(numericLhs, tstl.createNumericLiteral(0));

    const { scopeDefs } = collectScopeInfo([stmt], false);
    expect(scopeDefs.size).toBe(0);
  });

  it("does not collect function-definition params when shallow=true", () => {
    // shallow=true: !shallow is false → function-definition params skipped (line 79)
    const fnDef = tstl.createAssignmentStatement(
      makeAccess("module", "fn"),
      tstl.createFunctionExpression(tstl.createBlock([]), [tstl.createIdentifier("param")]),
    );

    const { scopeDefs } = collectScopeInfo([fnDef], true);
    // Only the LHS chain is collected; "param" must not appear
    expect(scopeDefs).toStrictEqual(new Set(["module.fn"]));
  });

  it("handles function-definition whose params are undefined (no params list)", () => {
    // FunctionExpression with params=undefined triggers the `?.` short-circuit in line 79
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    Reflect.set(funcExpr, "params", undefined);
    const fnDef = tstl.createAssignmentStatement(makeAccess("module", "fn"), funcExpr);

    const { scopeDefs } = collectScopeInfo([fnDef], false);
    expect(scopeDefs).toStrictEqual(new Set(["module.fn"]));
  });

  it("ignores non-identifier function and loop parameters", () => {
    const variadicExpr = tstl.createFunctionExpression(tstl.createBlock([]), [
      tstl.createIdentifier("arg"),
    ]);
    Reflect.set(variadicExpr, "params", [tstl.createDotsLiteral()]);
    const variadicDefinition = tstl.createAssignmentStatement(
      tstl.createIdentifier("fn"),
      tstl.createFunctionExpression(tstl.createBlock([]), [tstl.createIdentifier("arg")]),
    );
    const definedFunction = variadicDefinition.right[0];
    if (!tstl.isFunctionExpression(definedFunction)) {
      throw new Error("Expected FunctionExpression");
    }
    Reflect.set(definedFunction, "params", [tstl.createDotsLiteral()]);
    const forIn = tstl.createForInStatement(
      tstl.createBlock([]),
      [tstl.createIdentifier("value")],
      [tstl.createIdentifier("iter")],
    );
    Reflect.set(forIn, "names", [tstl.createDotsLiteral()]);

    const { scopeDefs } = collectScopeInfo(
      [tstl.createExpressionStatement(variadicExpr), variadicDefinition, forIn],
      false,
    );

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

  it("marks LHS array element writes without counting them as reads", () => {
    // t[i] on LHS (assignment statement)
    const table = tstl.createIdentifier("t");
    const index = tstl.createIdentifier("i");
    const lhs = tstl.createTableIndexExpression(table, index);
    const stmt = tstl.createAssignmentStatement([lhs], [tstl.createNumericLiteral(1)]);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), true);

    expect(info.counts.has("t")).toBe(false);
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

  it("excludes array base from hoisting when accessed with different loop variables", () => {
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

  it("cleanup removes tracking for arrays with mixed loop variable indices", () => {
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

  it.each([
    { shallow: false, expectedCount: 1, description: "includes function bodies" },
    { shallow: true, expectedCount: 0, description: "skips function bodies" },
  ])("array access collection $description", ({ shallow, expectedCount }) => {
    const funcBody = tstl.createBlock([
      tstl.createExpressionStatement(
        tstl.createTableIndexExpression(tstl.createIdentifier("t"), tstl.createIdentifier("i")),
      ),
    ]);
    const funcExpr = tstl.createFunctionExpression(funcBody, []);
    const stmt = tstl.createVariableDeclarationStatement(tstl.createIdentifier("f"), funcExpr);

    const info = collectArrayElementAccesses([stmt], new Set(["i"]), shallow);
    expect(info.counts.get("t") ?? 0).toBe(expectedCount);
  });

  it("does not count guarded array reads toward localization", () => {
    const guardedRead = tstl.createIfStatement(
      tstl.createIdentifier("cond"),
      tstl.createBlock([
        tstl.createExpressionStatement(
          tstl.createTableIndexExpression(
            tstl.createIdentifier("values"),
            tstl.createIdentifier("i"),
          ),
        ),
      ]),
    );

    const info = collectArrayElementAccesses([guardedRead], new Set(["i"]), true);

    expect(info.counts.size).toBe(0);
    expect(info.loopVar.size).toBe(0);
    expect(info.writes.size).toBe(0);
  });
});
