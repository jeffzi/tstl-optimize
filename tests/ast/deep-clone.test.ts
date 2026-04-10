import fc from "fast-check";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { deepCloneExpression, deepCloneStatement } from "../../src/ast/deep-clone";
import { arbExpression } from "../arbitraries";

function id(text: string, symbolId?: tstl.SymbolId, originalName?: string): tstl.Identifier {
  return tstl.createIdentifier(text, undefined, symbolId, originalName);
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
    const original = id("myVar", 42 as tstl.SymbolId);
    original.originalName = "renamed";

    const cloned = deepCloneExpression(original);

    expect(cloned).not.toBe(original);
    expect(cloned).toStrictEqual(original);
  });

  it("clones CallExpression and TableExpression fields independently", () => {
    const call = tstl.createCallExpression(id("fn"), [id("a"), id("b")]);
    const clonedCall = deepCloneExpression(call);
    assertNode(clonedCall, tstl.isCallExpression);
    expect(clonedCall).not.toBe(call);
    expect(clonedCall.params[0]).not.toBe(call.params[0]);
    expect(clonedCall).toStrictEqual(call);

    const field = tstl.createTableFieldExpression(id("v"), id("k"));
    const tbl = tstl.createTableExpression([field]);
    const clonedTbl = deepCloneExpression(tbl);
    assertNode(clonedTbl, tstl.isTableExpression);
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

  it("handles undefined FunctionExpression body without crashing", () => {
    const funcExpr = tstl.createFunctionExpression(tstl.createBlock([]));
    Object.assign(funcExpr, { body: undefined });

    const cloned = deepCloneExpression(funcExpr);
    assertNode(cloned, tstl.isFunctionExpression);

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
    const clonedVar = deepCloneStatement(varDecl);
    assertNode(clonedVar, tstl.isVariableDeclarationStatement);
    expect(clonedVar.left[0]).not.toBe(varDecl.left[0]);
    expect(clonedVar.right?.[0]).not.toBe(varDecl.right?.[0]);
    expect(clonedVar).toStrictEqual(varDecl);

    const assign = tstl.createAssignmentStatement([id("x")], [id("y")]);
    const clonedAssign = deepCloneStatement(assign);
    assertNode(clonedAssign, tstl.isAssignmentStatement);
    expect(clonedAssign.left[0]).not.toBe(assign.left[0]);
    expect(clonedAssign.right[0]).not.toBe(assign.right[0]);
    expect(clonedAssign).toStrictEqual(assign);
  });

  it("clones For and ForIn statements", () => {
    const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    const clonedFor = deepCloneStatement(forStmt);
    assertNode(clonedFor, tstl.isForStatement);
    expect(clonedFor).not.toBe(forStmt);
    expect(clonedFor.controlVariable).not.toBe(forStmt.controlVariable);
    expect(clonedFor).toStrictEqual(forStmt);

    const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("v")]);
    const clonedForIn = deepCloneStatement(forIn);
    assertNode(clonedForIn, tstl.isForInStatement);
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

describe("property-based", () => {
  it("structural equality: clone has same kind and values at every node", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const cloned = deepCloneExpression(expr);

        expect(structurallyEqual(expr, cloned)).toBe(true);
      }),
    );
  });

  it("referential independence: no node in clone is identical to any original node", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const originalNodes = collectNodes(expr);
        const cloned = deepCloneExpression(expr);
        const clonedNodes = collectNodes(cloned);

        for (const node of clonedNodes) {
          expect(originalNodes.has(node)).toBe(false);
        }
      }),
    );
  });

  it("idempotence: cloning twice produces a tree structurally equal to cloning once", () => {
    fc.assert(
      fc.property(arbExpression, (expr) => {
        const once = deepCloneExpression(expr);
        const twice = deepCloneExpression(once);

        expect(structurallyEqual(once, twice)).toBe(true);
      }),
    );
  });
});

describe("deepCloneExpression additional node kinds", () => {
  function id(text: string): tstl.Identifier {
    return tstl.createIdentifier(text);
  }

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
    expect(cloned).toStrictEqual(expr);
  });

  it("clones FunctionExpression with dots", () => {
    const body = tstl.createBlock([]);
    const dots = tstl.createDotsLiteral();
    const expr = tstl.createFunctionExpression(body, [], dots);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });
});

describe("deepCloneStatement additional node kinds", () => {
  function id(text: string): tstl.Identifier {
    return tstl.createIdentifier(text);
  }

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

  it("clones IfStatement with and without elseif/else", () => {
    const elseif = tstl.createIfStatement(id("c2"), tstl.createBlock([]), tstl.createBlock([]));
    const stmt1 = tstl.createIfStatement(id("c1"), tstl.createBlock([]), elseif);
    expect(deepCloneStatement(stmt1)).toStrictEqual(stmt1);

    const stmt2 = tstl.createIfStatement(id("c1"), tstl.createBlock([]));
    expect(deepCloneStatement(stmt2)).toStrictEqual(stmt2);

    const stmt3 = tstl.createIfStatement(id("c1"), tstl.createBlock([]), tstl.createBlock([]));
    expect(deepCloneStatement(stmt3)).toStrictEqual(stmt3);
  });

  it("clones ForStatement with and without step", () => {
    const withStep = tstl.createForStatement(
      tstl.createBlock([]),
      id("i"),
      id("a"),
      id("b"),
      id("s"),
    );
    const withoutStep = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    expect(deepCloneStatement(withStep)).toStrictEqual(withStep);
    expect(deepCloneStatement(withoutStep)).toStrictEqual(withoutStep);
  });
});
