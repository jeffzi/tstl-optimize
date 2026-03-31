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

  it("clones nested expression tree (binary containing call)", () => {
    const callExpr = tstl.createCallExpression(id("foo"), [id("x")]);
    const bin = tstl.createBinaryExpression(callExpr, id("y"), tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin) as tstl.BinaryExpression;
    const clonedCall = cloned.left as tstl.CallExpression;

    expect(clonedCall).not.toBe(callExpr);
    expect(clonedCall.expression).not.toBe(callExpr.expression);
    expect(clonedCall.params[0]).not.toBe(callExpr.params[0]);
    expect((clonedCall.expression as tstl.Identifier).text).toBe("foo");
  });

  it("preserves Identifier symbolId and text", () => {
    const original = id("myVar", 42 as tstl.SymbolId);
    original.originalName = "renamed";

    const cloned = deepCloneExpression(original) as tstl.Identifier;

    expect(cloned).not.toBe(original);
    expect(cloned.text).toBe("myVar");
    expect(cloned.symbolId).toBe(42);
    expect(cloned.originalName).toBe("renamed");
  });

  it("clones CallExpression params independently", () => {
    const param1 = id("a");
    const param2 = id("b");
    const call = tstl.createCallExpression(id("fn"), [param1, param2]);

    const cloned = deepCloneExpression(call) as tstl.CallExpression;

    expect(cloned).not.toBe(call);
    expect(cloned.expression).not.toBe(call.expression);
    expect(cloned.params[0]).not.toBe(param1);
    expect(cloned.params[1]).not.toBe(param2);
    expect((cloned.params[0] as tstl.Identifier).text).toBe("a");
    expect((cloned.params[1] as tstl.Identifier).text).toBe("b");
  });

  it("clones TableExpression fields independently", () => {
    const field1 = tstl.createTableFieldExpression(
      tstl.createNumericLiteral(1),
      tstl.createStringLiteral("x"),
    );
    const field2 = tstl.createTableFieldExpression(tstl.createNumericLiteral(2));
    const tbl = tstl.createTableExpression([field1, field2]);

    const cloned = deepCloneExpression(tbl) as tstl.TableExpression;

    expect(cloned).not.toBe(tbl);
    expect(cloned.fields[0]).not.toBe(field1);
    expect(cloned.fields[0].value).not.toBe(field1.value);
    expect(cloned.fields[0].key).not.toBe(field1.key);
    expect(cloned.fields[1]).not.toBe(field2);
    expect(cloned.fields[1].value).not.toBe(field2.value);
    expect(cloned.fields[1].key).toBeUndefined();
  });

  it("clones leaf nodes (literals) independently", () => {
    const str = tstl.createStringLiteral("hello");
    const num = tstl.createNumericLiteral(42);

    const clonedStr = deepCloneExpression(str);
    const clonedNum = deepCloneExpression(num);

    expect(clonedStr).not.toBe(str);
    expect((clonedStr as tstl.StringLiteral).value).toBe("hello");
    expect(clonedNum).not.toBe(num);
    expect((clonedNum as tstl.NumericLiteral).value).toBe(42);
  });

  it("clones FunctionExpression with deep body clone", () => {
    const bodyStmt = tstl.createReturnStatement([id("x", 10 as tstl.SymbolId)]);
    const body = tstl.createBlock([bodyStmt]);
    const funcExpr = tstl.createFunctionExpression(body, [id("x", 10 as tstl.SymbolId)]);

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).not.toBe(funcExpr.body);
    expect(cloned.body.statements[0]).not.toBe(bodyStmt);
    const clonedReturn = cloned.body.statements[0] as tstl.ReturnStatement;
    expect(clonedReturn.expressions[0]).not.toBe(bodyStmt.expressions[0]);
    expect((clonedReturn.expressions[0] as tstl.Identifier).text).toBe("x");
  });

  it("clones FunctionExpression with undefined body returns empty block (no crash)", () => {
    // FunctionExpression.body is typed as Block but can be undefined at runtime
    // (e.g. from partial AST nodes). The guard must prevent a crash.
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    // Force body to undefined to simulate the null-body case
    (funcExpr as unknown as { body: undefined }).body = undefined;

    const cloned = deepCloneExpression(funcExpr) as tstl.FunctionExpression;

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).toBeDefined();
    expect(cloned.body.statements).toHaveLength(0);
  });

  it("clones UnaryExpression independently", () => {
    const operand = id("x");
    const unary = tstl.createUnaryExpression(operand, tstl.SyntaxKind.NegationOperator);

    const cloned = deepCloneExpression(unary) as tstl.UnaryExpression;

    expect(cloned).not.toBe(unary);
    expect(cloned.operand).not.toBe(operand);
    expect((cloned.operand as tstl.Identifier).text).toBe("x");
  });

  it("clones MethodCallExpression independently", () => {
    const prefix = id("obj");
    const name = id("method");
    const method = tstl.createMethodCallExpression(prefix, name, [id("arg")]);

    const cloned = deepCloneExpression(method) as tstl.MethodCallExpression;

    expect(cloned).not.toBe(method);
    expect(cloned.prefixExpression).not.toBe(prefix);
    expect(cloned.name).not.toBe(name);
    expect(cloned.params[0]).not.toBe(method.params[0]);
  });

  it("clones ConditionalExpression independently", () => {
    const cond = tstl.createConditionalExpression(id("c"), id("t"), id("f"));

    const cloned = deepCloneExpression(cond) as tstl.ConditionalExpression;

    expect(cloned).not.toBe(cond);
    expect(cloned.condition).not.toBe(cond.condition);
    expect(cloned.whenTrue).not.toBe(cond.whenTrue);
    expect(cloned.whenFalse).not.toBe(cond.whenFalse);
  });

  it("clones TableIndexExpression independently", () => {
    const table = id("tbl");
    const index = tstl.createStringLiteral("key");
    const tblIdx = tstl.createTableIndexExpression(table, index);

    const cloned = deepCloneExpression(tblIdx) as tstl.TableIndexExpression;

    expect(cloned).not.toBe(tblIdx);
    expect(cloned.table).not.toBe(table);
    expect(cloned.index).not.toBe(index);
  });

  it("clones ParenthesizedExpression independently", () => {
    const inner = id("x");
    const paren = tstl.createParenthesizedExpression(inner);

    const cloned = deepCloneExpression(paren) as tstl.ParenthesizedExpression;

    expect(cloned).not.toBe(paren);
    expect(cloned.expression).not.toBe(inner);
  });
});

describe("deepCloneStatement", () => {
  it("clones DoStatement with independent nested statements", () => {
    const inner = tstl.createReturnStatement([id("x")]);
    const doStmt = tstl.createDoStatement([inner]);

    const cloned = deepCloneStatement(doStmt) as tstl.DoStatement;

    expect(cloned).not.toBe(doStmt);
    expect(cloned.statements[0]).not.toBe(inner);
    const clonedReturn = cloned.statements[0] as tstl.ReturnStatement;
    expect(clonedReturn.expressions[0]).not.toBe((inner as tstl.ReturnStatement).expressions[0]);
  });

  it("clones VariableDeclarationStatement independently", () => {
    const leftId = id("x", 1 as tstl.SymbolId);
    const rightExpr = tstl.createNumericLiteral(42);
    const varDecl = tstl.createVariableDeclarationStatement([leftId], [rightExpr]);

    const cloned = deepCloneStatement(varDecl) as tstl.VariableDeclarationStatement;

    expect(cloned).not.toBe(varDecl);
    expect(cloned.left[0]).not.toBe(leftId);
    expect((cloned.left[0] as tstl.Identifier).text).toBe("x");
    expect((cloned.left[0] as tstl.Identifier).symbolId).toBe(1);
    expect(cloned.right?.[0]).not.toBe(rightExpr);
    expect((cloned.right?.[0] as tstl.NumericLiteral).value).toBe(42);
  });

  it("clones AssignmentStatement independently", () => {
    const leftId = id("x");
    const rightExpr = tstl.createNumericLiteral(10);
    const assign = tstl.createAssignmentStatement([leftId], [rightExpr]);

    const cloned = deepCloneStatement(assign) as tstl.AssignmentStatement;

    expect(cloned).not.toBe(assign);
    expect(cloned.left[0]).not.toBe(leftId);
    expect(cloned.right[0]).not.toBe(rightExpr);
  });

  it("clones IfStatement with independent condition and blocks", () => {
    const condition = id("cond");
    const ifBlock = tstl.createBlock([tstl.createReturnStatement([id("a")])]);
    const elseBlock = tstl.createBlock([tstl.createReturnStatement([id("b")])]);
    const ifStmt = tstl.createIfStatement(condition, ifBlock, elseBlock);

    const cloned = deepCloneStatement(ifStmt) as tstl.IfStatement;

    expect(cloned).not.toBe(ifStmt);
    expect(cloned.condition).not.toBe(condition);
    expect(cloned.ifBlock).not.toBe(ifBlock);
    expect(cloned.ifBlock.statements[0]).not.toBe(ifBlock.statements[0]);
    expect(cloned.elseBlock).not.toBe(elseBlock);
  });

  it("clones IfStatement with elseif chain", () => {
    const elseIf = tstl.createIfStatement(
      id("cond2"),
      tstl.createBlock([tstl.createReturnStatement([id("b")])]),
    );
    const ifStmt = tstl.createIfStatement(
      id("cond1"),
      tstl.createBlock([tstl.createReturnStatement([id("a")])]),
      elseIf,
    );

    const cloned = deepCloneStatement(ifStmt) as tstl.IfStatement;

    expect(cloned).not.toBe(ifStmt);
    expect(cloned.elseBlock).not.toBe(elseIf);
    expect((cloned.elseBlock as tstl.IfStatement).condition).not.toBe(elseIf.condition);
  });

  it("clones ForStatement with independent children", () => {
    const controlVar = id("i", 1 as tstl.SymbolId);
    const init = tstl.createNumericLiteral(0);
    const limit = tstl.createNumericLiteral(10);
    const step = tstl.createNumericLiteral(1);
    const body = tstl.createBlock([tstl.createExpressionStatement(id("x"))]);
    const forStmt = tstl.createForStatement(body, controlVar, init, limit, step);

    const cloned = deepCloneStatement(forStmt) as tstl.ForStatement;

    expect(cloned).not.toBe(forStmt);
    expect(cloned.controlVariable).not.toBe(controlVar);
    expect(cloned.controlVariableInitializer).not.toBe(init);
    expect(cloned.limitExpression).not.toBe(limit);
    expect(cloned.stepExpression).not.toBe(step);
    expect(cloned.body).not.toBe(body);
    expect(cloned.body.statements[0]).not.toBe(body.statements[0]);
  });

  it("clones ForInStatement with independent children", () => {
    const names = [id("k"), id("v")];
    const exprs = [tstl.createCallExpression(id("pairs"), [id("tbl")])];
    const body = tstl.createBlock([tstl.createExpressionStatement(id("x"))]);
    const forIn = tstl.createForInStatement(body, names, exprs);

    const cloned = deepCloneStatement(forIn) as tstl.ForInStatement;

    expect(cloned).not.toBe(forIn);
    expect(cloned.names[0]).not.toBe(names[0]);
    expect(cloned.names[1]).not.toBe(names[1]);
    expect(cloned.expressions[0]).not.toBe(exprs[0]);
    expect(cloned.body).not.toBe(body);
  });

  it("clones ReturnStatement with independent expressions", () => {
    const expr1 = id("a");
    const expr2 = id("b");
    const ret = tstl.createReturnStatement([expr1, expr2]);

    const cloned = deepCloneStatement(ret) as tstl.ReturnStatement;

    expect(cloned).not.toBe(ret);
    expect(cloned.expressions[0]).not.toBe(expr1);
    expect(cloned.expressions[1]).not.toBe(expr2);
    expect((cloned.expressions[0] as tstl.Identifier).text).toBe("a");
  });

  it("clones ExpressionStatement independently", () => {
    const expr = tstl.createCallExpression(id("foo"), [id("x")]);
    const exprStmt = tstl.createExpressionStatement(expr);

    const cloned = deepCloneStatement(exprStmt) as tstl.ExpressionStatement;

    expect(cloned).not.toBe(exprStmt);
    expect(cloned.expression).not.toBe(expr);
    expect((cloned.expression as tstl.CallExpression).params[0]).not.toBe(expr.params[0]);
  });

  it("clones WhileStatement independently", () => {
    const cond = id("running");
    const body = tstl.createBlock([tstl.createExpressionStatement(id("x"))]);
    const whileStmt = tstl.createWhileStatement(body, cond);

    const cloned = deepCloneStatement(whileStmt) as tstl.WhileStatement;

    expect(cloned).not.toBe(whileStmt);
    expect(cloned.condition).not.toBe(cond);
    expect(cloned.body).not.toBe(body);
  });

  it("clones RepeatStatement independently", () => {
    const body = tstl.createBlock([tstl.createExpressionStatement(id("x"))]);
    const cond = id("done");
    const repeatStmt = tstl.createRepeatStatement(body, cond);

    const cloned = deepCloneStatement(repeatStmt) as tstl.RepeatStatement;

    expect(cloned).not.toBe(repeatStmt);
    expect(cloned.condition).not.toBe(cond);
    expect(cloned.body).not.toBe(body);
  });

  it("clones GotoStatement independently", () => {
    const gotoStmt = tstl.createGotoStatement("myLabel");

    const cloned = deepCloneStatement(gotoStmt) as tstl.GotoStatement;

    expect(cloned).not.toBe(gotoStmt);
    expect(cloned.label).toBe("myLabel");
  });

  it("clones LabelStatement independently", () => {
    const labelStmt = tstl.createLabelStatement("myLabel");

    const cloned = deepCloneStatement(labelStmt) as tstl.LabelStatement;

    expect(cloned).not.toBe(labelStmt);
    expect(cloned.name).toBe("myLabel");
  });

  it("clones BreakStatement independently", () => {
    const breakStmt = tstl.createBreakStatement();

    const cloned = deepCloneStatement(breakStmt);

    expect(cloned).not.toBe(breakStmt);
    expect(cloned.kind).toBe(tstl.SyntaxKind.BreakStatement);
  });
});
