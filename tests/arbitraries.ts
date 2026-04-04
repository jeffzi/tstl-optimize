import fc from "fast-check";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/**
 * Safe ASCII strings that embed cleanly into TS double-quoted source literals
 * (no quotes, backslashes, or whitespace control characters).
 */
export const arbSafeString = fc
  .string({ minLength: 0, maxLength: 10 })
  .filter((s) => !/["\\'\n\r\t\0]/.test(s));

// ---------------------------------------------------------------------------
// TSTL AST expression tree arbitrary (for deep-clone tests)
// ---------------------------------------------------------------------------

const arbBinaryOp = fc.constantFrom(
  tstl.SyntaxKind.AdditionOperator,
  tstl.SyntaxKind.SubtractionOperator,
  tstl.SyntaxKind.MultiplicationOperator,
);

const arbUnaryOp = fc.constantFrom(tstl.SyntaxKind.NegationOperator, tstl.SyntaxKind.NotOperator);

/** Recursive arbitrary producing TSTL expression AST nodes. */
export const arbExpression: fc.Arbitrary<tstl.Expression> = fc.letrec<{
  expr: tstl.Expression;
}>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3, depthIdentifier: "expr" },
    // Leaf nodes
    fc
      .double({ noNaN: true, noDefaultInfinity: true, min: -1000, max: 1000 })
      .map((n) => tstl.createNumericLiteral(n)),
    fc.string({ minLength: 1, maxLength: 5 }).map((s) => tstl.createStringLiteral(s)),
    fc.boolean().map((b) => tstl.createBooleanLiteral(b)),
    fc.string({ minLength: 1, maxLength: 8 }).map((name) => tstl.createIdentifier(name)),
    // Compound nodes
    fc
      .tuple(tie("expr"), tie("expr"), arbBinaryOp)
      .map(([l, r, op]) => tstl.createBinaryExpression(l, r, op)),
    fc
      .tuple(tie("expr"), arbUnaryOp)
      .map(([operand, op]) => tstl.createUnaryExpression(operand, op)),
    tie("expr").map((e) => tstl.createParenthesizedExpression(e)),
  ),
})).expr;
