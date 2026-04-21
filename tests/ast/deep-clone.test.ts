import fc from "fast-check";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { deepCloneExpression, deepCloneStatement } from "../../src/ast/deep-clone";
import { arbExpression } from "../arbitraries";

function id(text: string, symbolId?: number, originalName?: string): tstl.Identifier {
  return tstl.createIdentifier(
    text,
    undefined,
    symbolId as tstl.SymbolId | undefined,
    originalName,
  );
}

function bareReturnStatement(): tstl.ReturnStatement {
  return Reflect.apply(tstl.createReturnStatement, undefined, []);
}

function assertNode<T extends tstl.Node>(
  node: tstl.Node,
  guard: (n: tstl.Node) => n is T,
): asserts node is T {
  if (!guard(node)) throw new Error(`Unexpected node kind: ${node.kind}`);
}

describe("deepCloneExpression", () => {
  it("clones BinaryExpression with independent child references", () => {
    const left = id("a", 1);
    const right = id("b", 2);
    const bin = tstl.createBinaryExpression(left, right, tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin);
    assertNode(cloned, tstl.isBinaryExpression);

    expect(cloned).not.toBe(bin);
    expect(cloned.left).not.toBe(bin.left);
    expect(cloned.right).not.toBe(bin.right);
    expect(cloned).toStrictEqual(bin);
  });

  it("clones nested tree (binary containing call)", () => {
    const callExpr = tstl.createCallExpression(id("foo"), [id("x")]);
    const bin = tstl.createBinaryExpression(callExpr, id("y"), tstl.SyntaxKind.AdditionOperator);

    const cloned = deepCloneExpression(bin);
    assertNode(cloned, tstl.isBinaryExpression);

    expect(cloned).not.toBe(bin);
    expect(cloned.left).not.toBe(callExpr);
    expect(cloned).toStrictEqual(bin);
  });

  it("preserves Identifier symbolId and originalName", () => {
    const original = id("myVar", 42);
    original.originalName = "renamed";

    const cloned = deepCloneExpression(original);

    expect(cloned).not.toBe(original);
    expect(cloned).toStrictEqual(original);
  });

  it("clones CallExpression fields independently", () => {
    const call = tstl.createCallExpression(id("fn"), [id("a"), id("b")]);
    const cloned = deepCloneExpression(call);
    assertNode(cloned, tstl.isCallExpression);

    expect(cloned).not.toBe(call);
    expect(cloned.params[0]).not.toBe(call.params[0]);
    expect(cloned).toStrictEqual(call);
  });

  it("preserves CallExpression semantic flags and source position", () => {
    const call = tstl.createCallExpression(id("fn"), [id("value")]);
    call.flags |= tstl.NodeFlags.TableUnpackCall;
    call.line = 12;
    call.column = 4;

    const cloned = deepCloneExpression(call);
    assertNode(cloned, tstl.isCallExpression);

    expect(cloned).not.toBe(call);
    expect(cloned.flags & tstl.NodeFlags.TableUnpackCall).toBe(tstl.NodeFlags.TableUnpackCall);
    expect(cloned.line).toBe(12);
    expect(cloned.column).toBe(4);
  });

  it("clones TableExpression fields independently", () => {
    const field = tstl.createTableFieldExpression(id("v"), id("k"));
    const tbl = tstl.createTableExpression([field]);
    const cloned = deepCloneExpression(tbl);
    assertNode(cloned, tstl.isTableExpression);

    expect(cloned).not.toBe(tbl);
    expect(cloned.fields[0]).not.toBe(field);
    expect(cloned.fields[0].key).not.toBe(field.key);
    expect(cloned).toStrictEqual(tbl);
  });

  it.each([
    { expr: tstl.createStringLiteral("hello"), name: "StringLiteral" },
    { expr: tstl.createNumericLiteral(42), name: "NumericLiteral" },
  ])("clones leaf node: $name", ({ expr }) => {
    const cloned = deepCloneExpression(expr);

    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones FunctionExpression with deep body clone", () => {
    const bodyStmt = tstl.createReturnStatement([id("x", 10)]);
    const body = tstl.createBlock([bodyStmt]);
    const funcExpr = tstl.createFunctionExpression(body, [id("x", 10)]);

    const cloned = deepCloneExpression(funcExpr);
    assertNode(cloned, tstl.isFunctionExpression);

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).not.toBe(funcExpr.body);
    expect(cloned.body.statements[0]).not.toBe(bodyStmt);
    expect(cloned).toStrictEqual(funcExpr);
  });

  it("clones FunctionExpression with bare return in body", () => {
    const bodyStmt = bareReturnStatement();
    const body = tstl.createBlock([bodyStmt]);
    const funcExpr = tstl.createFunctionExpression(body);

    const cloned = deepCloneExpression(funcExpr);
    assertNode(cloned, tstl.isFunctionExpression);
    assertNode(cloned.body.statements[0], tstl.isReturnStatement);

    expect(cloned).not.toBe(funcExpr);
    expect(cloned.body).not.toBe(funcExpr.body);
    expect(cloned.body.statements[0]).not.toBe(bodyStmt);
    expect(cloned.body.statements[0].expressions).toBeUndefined();
    expect(cloned).toStrictEqual(funcExpr);
  });

  it("throws when FunctionExpression body is missing", () => {
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    Object.assign(funcExpr, { body: undefined });

    expect(() => deepCloneExpression(funcExpr)).toThrow(/FunctionExpression body/);
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

  it("clones MethodCallExpression", () => {
    const expr = tstl.createMethodCallExpression(id("obj"), id("method"), [id("arg")]);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones TableExpression with and without keys", () => {
    const field1 = tstl.createTableFieldExpression(id("v1"), id("k1"));
    const field2 = tstl.createTableFieldExpression(id("v2")); // No key
    const expr = tstl.createTableExpression([field1, field2]);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    assertNode(cloned, tstl.isTableExpression);
    expect(cloned.fields[0]).not.toBe(field1);
    expect(cloned.fields[0].key).not.toBe(field1.key);
    expect(cloned.fields[1]).not.toBe(field2);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones FunctionExpression with dots", () => {
    const body = tstl.createBlock([]);
    const dots = tstl.createDotsLiteral();
    const expr = tstl.createFunctionExpression(body, [], dots);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    assertNode(cloned, tstl.isFunctionExpression);
    expect(cloned.body).not.toBe(body);
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

  it("clones VariableDeclarationStatement independently", () => {
    const varDecl = tstl.createVariableDeclarationStatement([id("x")], [id("y")]);
    const cloned = deepCloneStatement(varDecl);
    assertNode(cloned, tstl.isVariableDeclarationStatement);

    expect(cloned.left[0]).not.toBe(varDecl.left[0]);
    expect(cloned.right?.[0]).not.toBe(varDecl.right?.[0]);
    expect(cloned).toStrictEqual(varDecl);
  });

  it("clones AssignmentStatement independently", () => {
    const assign = tstl.createAssignmentStatement([id("x")], [id("y")]);
    const cloned = deepCloneStatement(assign);
    assertNode(cloned, tstl.isAssignmentStatement);

    expect(cloned.left[0]).not.toBe(assign.left[0]);
    expect(cloned.right[0]).not.toBe(assign.right[0]);
    expect(cloned).toStrictEqual(assign);
  });

  it("clones ForStatement independently", () => {
    const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    const cloned = deepCloneStatement(forStmt);
    assertNode(cloned, tstl.isForStatement);

    expect(cloned).not.toBe(forStmt);
    expect(cloned.controlVariable).not.toBe(forStmt.controlVariable);
    expect(cloned).toStrictEqual(forStmt);
  });

  it("clones ForInStatement independently", () => {
    const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("v")]);
    const cloned = deepCloneStatement(forIn);
    assertNode(cloned, tstl.isForInStatement);

    expect(cloned).not.toBe(forIn);
    expect(cloned.names[0]).not.toBe(forIn.names[0]);
    expect(cloned).toStrictEqual(forIn);
  });

  it("preserves statement semantic flags and source position", () => {
    const stmt = tstl.createReturnStatement([id("value")]);
    stmt.flags |= tstl.NodeFlags.Inline;
    stmt.line = 12;
    stmt.column = 4;

    const cloned = deepCloneStatement(stmt);
    assertNode(cloned, tstl.isReturnStatement);

    expect(cloned).not.toBe(stmt);
    expect(cloned.flags & tstl.NodeFlags.Inline).toBe(tstl.NodeFlags.Inline);
    expect(cloned.line).toBe(12);
    expect(cloned.column).toBe(4);
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

  it("clones RepeatStatement", () => {
    const stmt = tstl.createRepeatStatement(tstl.createBlock([]), tstl.createBooleanLiteral(true));
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it("clones LabelStatement", () => {
    const stmt = tstl.createLabelStatement("lbl");
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it.each([
    {
      name: "ReturnStatement",
      stmt: tstl.createReturnStatement([id("x")]),
    },
    {
      name: "AssignmentStatement",
      stmt: tstl.createAssignmentStatement([id("x")], [id("y")]),
    },
  ])("preserves leadingComments and trailingComments on $name clone", ({ stmt }) => {
    stmt.leadingComments = ["-- leading single", ["-- leading", "-- multiline"]];
    stmt.trailingComments = [["-- trailing", "-- multiline"], "-- trailing single"];

    const cloned = deepCloneStatement(stmt);

    expect(cloned).not.toBe(stmt);
    expect(cloned.leadingComments).toStrictEqual(stmt.leadingComments);
    expect(cloned.trailingComments).toStrictEqual(stmt.trailingComments);
    expect(cloned.leadingComments).not.toBe(stmt.leadingComments);
    expect(cloned.trailingComments).not.toBe(stmt.trailingComments);
  });

  it.each([
    {
      name: "with elseif and else clause",
      stmt: tstl.createIfStatement(
        id("c1"),
        tstl.createBlock([]),
        tstl.createIfStatement(id("c2"), tstl.createBlock([]), tstl.createBlock([])),
      ),
    },
    {
      name: "with only body block",
      stmt: tstl.createIfStatement(id("c1"), tstl.createBlock([])),
    },
    {
      name: "with body and else block",
      stmt: tstl.createIfStatement(id("c1"), tstl.createBlock([]), tstl.createBlock([])),
    },
  ])("clones IfStatement $name", ({ stmt }) => {
    const cloned = deepCloneStatement(stmt);

    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it.each([
    {
      name: "with step",
      stmt: tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"), id("s")),
    },
    {
      name: "without step",
      stmt: tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b")),
    },
  ])("clones ForStatement $name", ({ stmt }) => {
    const cloned = deepCloneStatement(stmt);

    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });
});

function collectNodes(expr: tstl.Expression): Set<object> {
  const nodes = new Set<object>();

  function walk(node: tstl.Expression): void {
    nodes.add(node);
    if (tstl.isBinaryExpression(node)) {
      walk(node.left);
      walk(node.right);
    } else if (tstl.isUnaryExpression(node)) {
      walk(node.operand);
    } else if (tstl.isParenthesizedExpression(node)) {
      walk(node.expression);
    }
  }

  walk(expr);
  return nodes;
}

function structurallyEqual(a: tstl.Expression, b: tstl.Expression): boolean {
  if (a.kind !== b.kind) return false;

  if (tstl.isBinaryExpression(a) && tstl.isBinaryExpression(b)) {
    return (
      a.operator === b.operator &&
      structurallyEqual(a.left, b.left) &&
      structurallyEqual(a.right, b.right)
    );
  }

  if (tstl.isUnaryExpression(a) && tstl.isUnaryExpression(b)) {
    return a.operator === b.operator && structurallyEqual(a.operand, b.operand);
  }

  if (tstl.isParenthesizedExpression(a) && tstl.isParenthesizedExpression(b)) {
    return structurallyEqual(a.expression, b.expression);
  }

  if (tstl.isIdentifier(a) && tstl.isIdentifier(b)) {
    return a.text === b.text;
  }

  if (tstl.isNumericLiteral(a) && tstl.isNumericLiteral(b)) {
    return a.value === b.value;
  }

  if (tstl.isStringLiteral(a) && tstl.isStringLiteral(b)) {
    return a.value === b.value;
  }

  // Boolean literals: same kind (TrueKeyword / FalseKeyword) already checked above
  return a.kind === b.kind;
}

describe("when cloning arbitrary expressions (property-based)", () => {
  it("clone has same kind and values at every node", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const cloned = deepCloneExpression(expr);

        expect(cloned).not.toBe(expr);
        expect(structurallyEqual(expr, cloned)).toBe(true);
      }),
    );
  });

  it("no node in clone is identical to any original node", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const originalNodes = collectNodes(expr);
        const cloned = deepCloneExpression(expr);
        const clonedNodes = collectNodes(cloned);

        const sharedNodes = [...clonedNodes].filter((node) => originalNodes.has(node));
        expect(sharedNodes).toHaveLength(0);
      }),
    );
  });

  it("cloning twice produces a tree structurally equal to cloning once", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const once = deepCloneExpression(expr);
        const twice = deepCloneExpression(once);

        expect(twice).not.toBe(once);
        expect(structurallyEqual(once, twice)).toBe(true);
      }),
    );
  });
});
