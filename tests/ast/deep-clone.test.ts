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
    expect((cloned.left as tstl.Identifier).text).toBe("a");
    expect((cloned.right as tstl.Identifier).text).toBe("b");
    expect(cloned.operator).toBe(tstl.SyntaxKind.AdditionOperator);
  });

  it("clones nested tree (binary containing call)", () => {
    const callExpr = tstl.createCallExpression(id("foo"), [id("x")]);
    const bin = tstl.createBinaryExpression(callExpr, id("y"), tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin) as tstl.BinaryExpression;
    const clonedCall = cloned.left as tstl.CallExpression;

    expect(clonedCall).not.toBe(callExpr);
    expect(clonedCall.expression).not.toBe(callExpr.expression);
    expect(clonedCall.params[0]).not.toBe(callExpr.params[0]);
    expect((clonedCall.expression as tstl.Identifier).text).toBe("foo");
  });

  it("preserves Identifier symbolId and originalName", () => {
    const original = id("myVar", 42 as tstl.SymbolId);
    original.originalName = "renamed";

    const cloned = deepCloneExpression(original) as tstl.Identifier;

    expect(cloned).not.toBe(original);
    expect(cloned.text).toBe("myVar");
    expect(cloned.symbolId).toBe(42);
    expect(cloned.originalName).toBe("renamed");
  });

  it("clones CallExpression and TableExpression fields independently", () => {
    const call = tstl.createCallExpression(id("fn"), [id("a"), id("b")]);
    const clonedCall = deepCloneExpression(call) as tstl.CallExpression;
    expect(clonedCall).not.toBe(call);
    expect(clonedCall.params[0]).not.toBe(call.params[0]);

    const field = tstl.createTableFieldExpression(id("v"), id("k"));
    const tbl = tstl.createTableExpression([field]);
    const clonedTbl = deepCloneExpression(tbl) as tstl.TableExpression;
    expect(clonedTbl).not.toBe(tbl);
    expect(clonedTbl.fields[0]).not.toBe(field);
    expect(clonedTbl.fields[0].key).not.toBe(field.key);
  });

  it("clones literals (leaf nodes)", () => {
    const str = tstl.createStringLiteral("hello");
    const num = tstl.createNumericLiteral(42);

    expect((deepCloneExpression(str) as tstl.StringLiteral).value).toBe("hello");
    expect((deepCloneExpression(num) as tstl.NumericLiteral).value).toBe(42);
  });

  it("clones FunctionExpression with deep body clone", () => {
    const bodyStmt = tstl.createReturnStatement([id("x", 10 as tstl.SymbolId)]);
    const body = tstl.createBlock([bodyStmt]);
    const funcExpr = tstl.createFunctionExpression(body, [id("x", 10 as tstl.SymbolId)]);

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).not.toBe(funcExpr.body);
    expect(cloned.body.statements[0]).not.toBe(bodyStmt);
  });

  it("handles undefined FunctionExpression body without crashing", () => {
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    (funcExpr as unknown as { body: undefined }).body = undefined;

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned.body).toBeDefined();
    expect(cloned.body.statements).toHaveLength(0);
  });

  it("clones various simple expressions", () => {
    const unary = tstl.createUnaryExpression(id("x"), tstl.SyntaxKind.NegationOperator);
    expect((deepCloneExpression(unary) as tstl.UnaryExpression).operand).not.toBe(unary.operand);

    const cond = tstl.createConditionalExpression(id("c"), id("t"), id("f"));
    expect((deepCloneExpression(cond) as tstl.ConditionalExpression).condition).not.toBe(
      cond.condition,
    );

    const tblIdx = tstl.createTableIndexExpression(id("tbl"), id("k"));
    expect((deepCloneExpression(tblIdx) as tstl.TableIndexExpression).table).not.toBe(tblIdx.table);

    const paren = tstl.createParenthesizedExpression(id("x"));
    expect((deepCloneExpression(paren) as tstl.ParenthesizedExpression).expression).not.toBe(
      paren.expression,
    );
  });
});

describe("deepCloneStatement", () => {
  it("clones block-based statements (Do, If, While, Repeat)", () => {
    const doStmt = tstl.createDoStatement([tstl.createReturnStatement([id("x")])]);
    expect((deepCloneStatement(doStmt) as tstl.DoStatement).statements[0]).not.toBe(
      doStmt.statements[0],
    );

    const ifStmt = tstl.createIfStatement(id("c"), tstl.createBlock([]), tstl.createBlock([]));
    expect((deepCloneStatement(ifStmt) as tstl.IfStatement).ifBlock).not.toBe(ifStmt.ifBlock);

    const whileStmt = tstl.createWhileStatement(tstl.createBlock([]), id("c"));
    expect((deepCloneStatement(whileStmt) as tstl.WhileStatement).body).not.toBe(whileStmt.body);
  });

  it("clones VariableDeclaration and Assignment statements", () => {
    const varDecl = tstl.createVariableDeclarationStatement([id("x")], [id("y")]);
    const clonedVar = deepCloneStatement(varDecl) as tstl.VariableDeclarationStatement;
    expect(clonedVar.left[0]).not.toBe(varDecl.left[0]);
    expect(clonedVar.right?.[0]).not.toBe(varDecl.right?.[0]);

    const assign = tstl.createAssignmentStatement([id("x")], [id("y")]);
    const clonedAssign = deepCloneStatement(assign) as tstl.AssignmentStatement;
    expect(clonedAssign.left[0]).not.toBe(assign.left[0]);
    expect(clonedAssign.right[0]).not.toBe(assign.right[0]);
  });

  it("clones For and ForIn statements", () => {
    const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    expect((deepCloneStatement(forStmt) as tstl.ForStatement).controlVariable).not.toBe(
      forStmt.controlVariable,
    );

    const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("v")]);
    expect((deepCloneStatement(forIn) as tstl.ForInStatement).names[0]).not.toBe(forIn.names[0]);
  });

  it("clones simple statements (Return, Expression, Goto, Label, Break)", () => {
    const ret = tstl.createReturnStatement([id("x")]);
    expect((deepCloneStatement(ret) as tstl.ReturnStatement).expressions[0]).not.toBe(
      ret.expressions[0],
    );

    const exprStmt = tstl.createExpressionStatement(id("x"));
    expect((deepCloneStatement(exprStmt) as tstl.ExpressionStatement).expression).not.toBe(
      exprStmt.expression,
    );

    const gotoStmt = tstl.createGotoStatement("lbl");
    expect((deepCloneStatement(gotoStmt) as tstl.GotoStatement).label).toBe("lbl");

    const breakStmt = tstl.createBreakStatement();
    expect(deepCloneStatement(breakStmt).kind).toBe(tstl.SyntaxKind.BreakStatement);
  });
});
