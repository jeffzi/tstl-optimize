import ts from "typescript";

/**
 * A discriminated union representing a primitive literal value extracted from a TypeScript node.
 */
export type LiteralKind =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean };

/**
 * Extracts a primitive literal value from a TypeScript expression node.
 *
 * Recursively unwraps:
 * - `ParenthesizedExpression` — `(42)` → `{ kind: "number", value: 42 }`
 * - `AsExpression` — `42 as const` → `{ kind: "number", value: 42 }`
 * - `TypeAssertionExpression` — `<const>42` → `{ kind: "number", value: 42 }`
 *
 * Recognizes:
 * - `NumericLiteral` → `{ kind: "number", value: number }`
 * - `StringLiteral` / `NoSubstitutionTemplateLiteral` → `{ kind: "string", value: string }`
 * - `TrueKeyword` / `FalseKeyword` → `{ kind: "boolean", value: boolean }`
 * - `PrefixUnaryExpression` with `MinusToken` or `PlusToken` over `NumericLiteral`
 *
 * Returns `undefined` for anything else (identifiers, binary expressions, object literals, etc.).
 */
export function extractPrimitiveLiteral(node: ts.Expression): LiteralKind | undefined {
  // Unwrap transparent wrapper nodes
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return extractPrimitiveLiteral(node.expression);
  }

  if (ts.isNumericLiteral(node)) {
    return { kind: "number", value: Number(node.text) };
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "string", value: node.text };
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: true };
  }

  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: false };
  }

  if (ts.isPrefixUnaryExpression(node)) {
    const { operator, operand } = node;
    if (
      (operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(operand)
    ) {
      const raw = Number(operand.text);
      const value = operator === ts.SyntaxKind.MinusToken ? -raw : +raw;
      return { kind: "number", value };
    }
  }

  return undefined;
}

/**
 * Synthesizes a fresh TypeScript AST node for a primitive literal value.
 *
 * - `number` (negative) → `PrefixUnaryExpression` with `MinusToken` over `NumericLiteral`
 * - `number` (non-negative) → `NumericLiteral`
 * - `string` → `StringLiteral`
 * - `boolean` → `TrueKeyword` / `FalseKeyword`
 */
export function synthesizeLiteralExpression(literal: LiteralKind): ts.Expression {
  switch (literal.kind) {
    case "number": {
      // Special case: detect negative zero using 1/x === -Infinity
      if (Object.is(literal.value, -0)) {
        return ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          ts.factory.createNumericLiteral("0"),
        );
      }
      if (literal.value < 0) {
        return ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          ts.factory.createNumericLiteral(Math.abs(literal.value).toString()),
        );
      }
      return ts.factory.createNumericLiteral(literal.value.toString());
    }
    case "string":
      return ts.factory.createStringLiteral(literal.value);
    case "boolean":
      return literal.value ? ts.factory.createTrue() : ts.factory.createFalse();
  }
}

/**
 * Resolves a TypeScript symbol to a primitive const literal, if possible.
 *
 * Returns `undefined` if:
 * - The symbol has no declarations
 * - No declaration is a `VariableDeclaration` in a `const` binding
 * - The initializer is not a primitive literal (e.g., object, call expression, binary expression)
 */
export function resolveConstLiteral(symbol: ts.Symbol): LiteralKind | undefined {
  const declarations = symbol.getDeclarations();
  if (declarations === undefined) return undefined;

  for (const declaration of declarations) {
    if (!ts.isVariableDeclaration(declaration)) continue;

    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    if ((list.flags & ts.NodeFlags.Const) === 0) continue;

    const { initializer } = declaration;
    if (initializer === undefined) continue;

    const result = extractPrimitiveLiteral(initializer);
    if (result !== undefined) return result;
  }

  return undefined;
}
