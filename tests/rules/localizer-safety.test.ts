// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { statementAssignsToChain } from "../../src/rules/localizer/safety";

describe("statementAssignsToChain", () => {
  /**
   * Helper to build a table-index chain like "a.b.c" from parts ["a", "b", "c"].
   * Returns a TableIndexExpression that nests left-to-right.
   */
  function buildChainExpression(parts: string[]): tstl.AssignmentLeftHandSideExpression {
    if (parts.length === 0) {
      throw new Error("chain must have at least one part");
    }
    let expr: tstl.AssignmentLeftHandSideExpression = tstl.createIdentifier(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      expr = tstl.createTableIndexExpression(expr, tstl.createStringLiteral(parts[i]));
    }
    return expr;
  }

  it.each([
    {
      description: "bare identifier a = 1 against chain a.b.c (new: root matches)",
      lhs: [tstl.createIdentifier("a")],
      chain: "a.b.c",
      expected: true,
    },
    {
      description: "bare identifier a = 1 against chain a (new: exact root match)",
      lhs: [tstl.createIdentifier("a")],
      chain: "a",
      expected: true,
    },
    {
      description: "bare identifier a = 1 against chain a.b (new: root is prefix)",
      lhs: [tstl.createIdentifier("a")],
      chain: "a.b",
      expected: true,
    },
    {
      description: "bare identifier y = 1 against chain a.b.c (unrelated)",
      lhs: [tstl.createIdentifier("y")],
      chain: "a.b.c",
      expected: false,
    },
    {
      description: "table-index a.b.c = 1 against chain a.b.c (existing: exact match)",
      lhs: [buildChainExpression(["a", "b", "c"])],
      chain: "a.b.c",
      expected: true,
    },
    {
      description: "table-index a.b = 1 against chain a.b.c (existing: prefix match)",
      lhs: [buildChainExpression(["a", "b"])],
      chain: "a.b.c",
      expected: true,
    },
    {
      description: "table-index a.x = 1 against chain a.b.c (non-prefix)",
      lhs: [buildChainExpression(["a", "x"])],
      chain: "a.b.c",
      expected: false,
    },
    {
      description: "do end block against chain a.b.c (non-assignment guard)",
      lhs: undefined, // will use DoStatement instead
      chain: "a.b.c",
      expected: false,
    },
  ])("$description", ({
    lhs,
    chain,
    expected,
  }: {
    lhs?: tstl.AssignmentLeftHandSideExpression[];
    chain: string;
    expected: boolean;
  }) => {
    const stmt =
      lhs !== undefined
        ? tstl.createAssignmentStatement(lhs, [tstl.createNumericLiteral(1)])
        : tstl.createDoStatement([]);
    const result = statementAssignsToChain(stmt, chain);
    expect(result).toBe(expected);
  });
});
