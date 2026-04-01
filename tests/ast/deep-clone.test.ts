// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { deepCloneExpression, deepCloneStatement } from "../../src/ast/deep-clone";

function id(text: string, symbolId?: tstl.SymbolId, originalName?: string): tstl.Identifier {
  return tstl.createIdentifier(text, undefined, symbolId, originalName);
}

describe("deepCloneExpression", () => {
  it("clones BinaryExpression with independent child references", () => {
    const left = id("a", 1 as tstl.SymbolId);
    const right = id("b", 2 as tstl.SymbolId);
    const bin = tstl.createBinaryExpression(left, right, tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin) as tstl.BinaryExpression;

    expect(cloned).not.toBe(bin);
    expect(cloned.left).not.toBe(bin.left);
    expect(cloned.right).not.toBe(bin.right);
    expect(cloned).toStrictEqual(bin);
  });

  it("clones nested tree (binary containing call)", () => {
    const callExpr = tstl.createCallExpression(id("foo"), [id("x")]);
    const bin = tstl.createBinaryExpression(callExpr, id("y"), tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin) as tstl.BinaryExpression;

    expect(cloned).not.toBe(bin);
    expect(cloned.left).not.toBe(callExpr);
    expect(cloned).toStrictEqual(bin);
  });

  it("preserves Identifier symbolId and originalName", () => {
    const original = id("myVar", 42 as tstl.SymbolId);
    original.originalName = "renamed";

    const cloned = deepCloneExpression(original);

    expect(cloned).not.toBe(original);
    expect(cloned).toStrictEqual(original);
  });

  it("clones CallExpression and TableExpression fields independently", () => {
    const call = tstl.createCallExpression(id("fn"), [id("a"), id("b")]);
    const clonedCall = deepCloneExpression(call) as tstl.CallExpression;
    expect(clonedCall).not.toBe(call);
    expect(clonedCall.params[0]).not.toBe(call.params[0]);
    expect(clonedCall).toStrictEqual(call);

    const field = tstl.createTableFieldExpression(id("v"), id("k"));
    const tbl = tstl.createTableExpression([field]);
    const clonedTbl = deepCloneExpression(tbl) as tstl.TableExpression;
    expect(clonedTbl).not.toBe(tbl);
    expect(clonedTbl.fields[0]).not.toBe(field);
    expect(clonedTbl.fields[0].key).not.toBe(field.key);
    expect(clonedTbl).toStrictEqual(tbl);
  });

  it("clones literals (leaf nodes)", () => {
    const str = tstl.createStringLiteral("hello");
    const num = tstl.createNumericLiteral(42);

    expect(deepCloneExpression(str)).toStrictEqual(str);
    expect(deepCloneExpression(num)).toStrictEqual(num);
  });

  it("clones FunctionExpression with deep body clone", () => {
    const bodyStmt = tstl.createReturnStatement([id("x", 10 as tstl.SymbolId)]);
    const body = tstl.createBlock([bodyStmt]);
    const funcExpr = tstl.createFunctionExpression(body, [id("x", 10 as tstl.SymbolId)]);

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).not.toBe(funcExpr.body);
    expect(cloned.body.statements[0]).not.toBe(bodyStmt);
    expect(cloned).toStrictEqual(funcExpr);
  });

  it("handles undefined FunctionExpression body without crashing", () => {
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    (funcExpr as unknown as { body: undefined }).body = undefined;

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned.body).toBeDefined();
    expect(cloned.body.statements).toHaveLength(0);
  });

  it.each([
    {
      expr: tstl.createUnaryExpression(id("x"), tstl.SyntaxKind.NegationOperator),
      name: "UnaryExpression",
    },
    {
      expr: tstl.createConditionalExpression(id("c"), id("t"), id("f")),
      name: "ConditionalExpression",
    },
    {
      expr: tstl.createTableIndexExpression(id("tbl"), id("k")),
      name: "TableIndexExpression",
    },
    {
      expr: tstl.createParenthesizedExpression(id("x")),
      name: "ParenthesizedExpression",
    },
  ])("clones $name", ({ expr }) => {
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });
});

describe("deepCloneStatement", () => {
  it.each([
    {
      name: "DoStatement",
      stmt: tstl.createDoStatement([tstl.createReturnStatement([id("x")])]),
    },
    {
      name: "IfStatement",
      stmt: tstl.createIfStatement(id("c"), tstl.createBlock([]), tstl.createBlock([])),
    },
    {
      name: "WhileStatement",
      stmt: tstl.createWhileStatement(tstl.createBlock([]), id("c")),
    },
  ])("clones block-based statement: $name", ({ stmt }) => {
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it("clones VariableDeclaration and Assignment statements", () => {
    const varDecl = tstl.createVariableDeclarationStatement([id("x")], [id("y")]);
    const clonedVar = deepCloneStatement(varDecl) as tstl.VariableDeclarationStatement;
    expect(clonedVar.left[0]).not.toBe(varDecl.left[0]);
    expect(clonedVar.right?.[0]).not.toBe(varDecl.right?.[0]);
    expect(clonedVar).toStrictEqual(varDecl);

    const assign = tstl.createAssignmentStatement([id("x")], [id("y")]);
    const clonedAssign = deepCloneStatement(assign) as tstl.AssignmentStatement;
    expect(clonedAssign.left[0]).not.toBe(assign.left[0]);
    expect(clonedAssign.right[0]).not.toBe(assign.right[0]);
    expect(clonedAssign).toStrictEqual(assign);
  });

  it("clones For and ForIn statements", () => {
    const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    const clonedFor = deepCloneStatement(forStmt) as tstl.ForStatement;
    expect(clonedFor).not.toBe(forStmt);
    expect(clonedFor.controlVariable).not.toBe(forStmt.controlVariable);
    expect(clonedFor).toStrictEqual(forStmt);

    const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("v")]);
    const clonedForIn = deepCloneStatement(forIn) as tstl.ForInStatement;
    expect(clonedForIn).not.toBe(forIn);
    expect(clonedForIn.names[0]).not.toBe(forIn.names[0]);
    expect(clonedForIn).toStrictEqual(forIn);
  });

  it.each([
    { name: "ReturnStatement", stmt: tstl.createReturnStatement([id("x")]) },
    { name: "ExpressionStatement", stmt: tstl.createExpressionStatement(id("x")) },
    { name: "GotoStatement", stmt: tstl.createGotoStatement("lbl") },
    { name: "BreakStatement", stmt: tstl.createBreakStatement() },
  ])("clones simple statement: $name", ({ stmt }) => {
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });
});
