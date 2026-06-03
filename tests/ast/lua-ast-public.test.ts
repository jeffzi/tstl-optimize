// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { isLuaRhsPure, unspillStatements } from "../../src/ast/lua-ast-public";

function id(text: string): tstl.Identifier {
  return tstl.createIdentifier(text);
}

function assertNode<T extends tstl.Node>(
  node: tstl.Node,
  guard: (n: tstl.Node) => n is T,
): asserts node is T {
  if (!guard(node)) throw new Error(`Unexpected node kind: ${node.kind}`);
}

function assertIsArchCompIndex(expr: tstl.Expression): void {
  assertNode(expr, tstl.isTableIndexExpression);
  assertNode(expr.table, tstl.isIdentifier);
  expect(expr.table.text).toBe("arch");
  assertNode(expr.index, tstl.isStringLiteral);
  expect(expr.index.value).toBe("Comp");
}

function buildInput(): tstl.Statement[] {
  const archCompRead = tstl.createTableIndexExpression(
    id("arch"),
    tstl.createStringLiteral("Comp"),
  );
  const iIdent = id("i");
  const declStmt = tstl.createVariableDeclarationStatement(
    [id("____b"), id("____k")],
    [archCompRead, iIdent],
  );
  const b = id("____b");
  const k = id("____k");
  const lhs = tstl.createTableIndexExpression(b, k);
  const rhs = tstl.createBinaryExpression(
    tstl.createTableIndexExpression(id("____b"), id("____k")),
    tstl.createNumericLiteral(5),
    tstl.SyntaxKind.AdditionOperator,
  );
  const assignStmt = tstl.createAssignmentStatement([lhs], [rhs]);
  return [declStmt, assignStmt];
}

function permissiveIsPure(expr: tstl.Expression): boolean {
  if (isLuaRhsPure(expr)) return true;
  if (tstl.isTableIndexExpression(expr)) {
    return permissiveIsPure(expr.table) && permissiveIsPure(expr.index);
  }
  return false;
}

describe("public lua-ast subpath", () => {
  describe("unspillStatements", () => {
    describe("when isPure is unspecified (default)", () => {
      it("leaves TableIndexExpression base/key temps intact", () => {
        const stmts = buildInput();
        const out = unspillStatements(stmts);
        expect(out.length).toBe(2);
        assertNode(out[0], tstl.isVariableDeclarationStatement);
        assertNode(out[1], tstl.isAssignmentStatement);
      });
    });

    describe("when isPure accepts TableIndexExpression as pure", () => {
      it("folds decl+assign into a single assignment with original base/key inlined", () => {
        const stmts = buildInput();
        const out = unspillStatements(stmts, { isPure: permissiveIsPure });
        expect(out.length).toBe(1);
        const folded = out[0];
        assertNode(folded, tstl.isAssignmentStatement);
        const lhs = folded.left[0];
        assertNode(lhs, tstl.isTableIndexExpression);
        assertIsArchCompIndex(lhs.table);
        const rhs = folded.right[0];
        assertNode(rhs, tstl.isBinaryExpression);
        assertNode(rhs.left, tstl.isTableIndexExpression);
        assertIsArchCompIndex(rhs.left.table);
        assertNode(rhs.right, tstl.isNumericLiteral);
        expect(rhs.right.value).toBe(5);
      });
    });
  });
});
