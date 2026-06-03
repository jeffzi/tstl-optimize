import ts from "typescript";

export type LiteralKind =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean };

export function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringifyTemplateSpanValue(literal: LiteralKind): string | undefined {
  switch (literal.kind) {
    case "string":
      return literal.value;
    case "boolean":
      return literal.value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(literal.value)) return undefined;
      if (Math.abs(literal.value) >= 1e14) return undefined;
      return String(literal.value);
  }
}

function evaluateTemplateLiteral(
  expression: ts.TemplateExpression,
  evaluateSpan: (node: ts.Expression) => LiteralKind | undefined,
): { kind: "string"; value: string } | undefined {
  let result = expression.head.text;
  for (const span of expression.templateSpans) {
    const spanValue = evaluateSpan(span.expression);
    if (spanValue === undefined) return undefined;
    const stringValue = stringifyTemplateSpanValue(spanValue);
    if (stringValue === undefined) return undefined;
    result += stringValue + span.literal.text;
  }
  return { kind: "string", value: result };
}

export function extractPrimitiveLiteral(node: ts.Expression): LiteralKind | undefined {
  const expression = unwrapTransparentExpression(node);

  if (ts.isNumericLiteral(expression)) {
    return { kind: "number", value: Number(expression.text) };
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { kind: "string", value: expression.text };
  }

  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: true };
  }

  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: false };
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    const { operator, operand } = expression;
    if (
      (operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(operand)
    ) {
      const raw = Number(operand.text);
      const value = operator === ts.SyntaxKind.MinusToken ? -raw : +raw;
      return { kind: "number", value };
    }
  }

  if (ts.isTemplateExpression(expression)) {
    return evaluateTemplateLiteral(expression, extractPrimitiveLiteral);
  }

  return undefined;
}

export function synthesizeLiteralExpression(literal: LiteralKind): ts.Expression {
  switch (literal.kind) {
    case "number": {
      // -0 === 0 in JS, so Object.is is needed to distinguish them.
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

type ConstInitializer = {
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
};

function findConstInitializer(symbol: ts.Symbol): ConstInitializer | undefined {
  const declarations = symbol.getDeclarations();
  if (declarations === undefined) return undefined;

  for (const declaration of declarations) {
    if (!ts.isVariableDeclaration(declaration)) continue;

    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    if ((list.flags & ts.NodeFlags.Const) === 0) continue;
    if (declaration.initializer === undefined) continue;

    return { declaration, initializer: declaration.initializer };
  }

  return undefined;
}

function isDeclaredAfterReference(
  declaration: ts.VariableDeclaration,
  reference: ts.Identifier,
): boolean {
  const sourceFile = reference.getSourceFile();
  if (declaration.getSourceFile() !== sourceFile) return false;
  return declaration.getStart(sourceFile) > reference.getStart(sourceFile);
}

function getConstValueSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

/**
 * Resolve a const initializer from a symbol referenced in an expression.
 * Handles symbol resolution, cycle detection, and forward-reference checks.
 */
function evaluateSymbolConstInitializer(
  symbol: ts.Symbol,
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol>,
): LiteralKind | undefined {
  const valueSymbol = getConstValueSymbol(symbol, checker);
  if (visited.has(valueSymbol)) return undefined;

  const constInitializer = findConstInitializer(valueSymbol);
  if (constInitializer === undefined) {
    return undefined;
  }

  // Guard against forward references (declaration appears after use)
  if (
    ts.isIdentifier(expression) &&
    isDeclaredAfterReference(constInitializer.declaration, expression)
  ) {
    return undefined;
  }

  visited.add(valueSymbol);
  try {
    return evaluateConstInitializer(constInitializer.initializer, checker, visited);
  } finally {
    visited.delete(valueSymbol);
  }
}

function evaluateConstInitializer(
  node: ts.Expression,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol>,
): LiteralKind | undefined {
  const expression = unwrapTransparentExpression(node);

  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return undefined;
    return evaluateSymbolConstInitializer(symbol, expression, checker, visited);
  }

  // Resolve namespace-import member accesses like `mod.X` inside const initializers.
  // This allows re-export chains (export const VALUE = ns.VALUE) to be evaluated.
  if (ts.isPropertyAccessExpression(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return undefined;
    return evaluateSymbolConstInitializer(symbol, expression, checker, visited);
  }

  if (ts.isTemplateExpression(expression)) {
    return evaluateTemplateLiteral(expression, (spanExpr) =>
      evaluateConstInitializer(spanExpr, checker, visited),
    );
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = evaluateConstInitializer(expression.operand, checker, visited);
    if (operand?.kind !== "number") return undefined;

    switch (expression.operator) {
      case ts.SyntaxKind.PlusToken:
        return { kind: "number", value: +operand.value };
      case ts.SyntaxKind.MinusToken:
        return { kind: "number", value: -operand.value };
      default:
        return undefined;
    }
  }

  if (ts.isBinaryExpression(expression)) {
    const left = evaluateConstInitializer(expression.left, checker, visited);
    const right = evaluateConstInitializer(expression.right, checker, visited);

    if (left === undefined || right === undefined) return undefined;

    if (
      left.kind === "string" &&
      right.kind === "string" &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return { kind: "string", value: left.value + right.value };
    }

    if (left.kind !== "number" || right.kind !== "number") return undefined;

    const result = evaluateBinaryOp(left.value, expression.operatorToken.kind, right.value);
    if (result === undefined) return undefined;
    if (!Number.isFinite(result)) return undefined;

    return { kind: "number", value: result };
  }

  return extractPrimitiveLiteral(expression);
}

function evaluateBinaryOp(
  left: number,
  operator: ts.SyntaxKind,
  right: number,
): number | undefined {
  switch (operator) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    case ts.SyntaxKind.PercentToken:
      if (left < 0 || right < 0) return undefined;
      if (!Number.isInteger(left) || !Number.isInteger(right)) return undefined;
      return left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    default:
      return undefined;
  }
}

export function resolveConstLiteral(
  symbol: ts.Symbol,
  checker?: ts.TypeChecker,
): LiteralKind | undefined {
  const constInitializer = findConstInitializer(symbol);
  if (constInitializer === undefined) return undefined;

  if (checker === undefined) {
    return extractPrimitiveLiteral(constInitializer.initializer);
  }

  return evaluateConstInitializer(constInitializer.initializer, checker, new Set());
}
