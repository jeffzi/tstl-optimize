import ts from "typescript";

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Returns true if the expression could have side effects (function call, increment, etc.) */
export function hasSideEffects(node: ts.Expression): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return true;
  if (ts.isTaggedTemplateExpression(node)) return true;
  if (
    ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken))
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node)) {
    if (isAssignmentOperator(node.operatorToken.kind)) return true;
    return hasSideEffects(node.left) || hasSideEffects(node.right);
  }
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return true;
  if (ts.isDeleteExpression(node)) return true;

  // Recurse into sub-expressions
  if (ts.isPropertyAccessExpression(node)) return hasSideEffects(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return hasSideEffects(node.expression) || hasSideEffects(node.argumentExpression);
  }
  if (ts.isParenthesizedExpression(node)) return hasSideEffects(node.expression);
  if (ts.isConditionalExpression(node)) {
    return (
      hasSideEffects(node.condition) ||
      hasSideEffects(node.whenTrue) ||
      hasSideEffects(node.whenFalse)
    );
  }
  if (ts.isSpreadElement(node)) return hasSideEffects(node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return hasSideEffects(node.expression);
  }
  if (ts.isNonNullExpression(node)) return hasSideEffects(node.expression);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((el) => hasSideEffects(el));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((prop) => {
      if (ts.isPropertyAssignment(prop)) return hasSideEffects(prop.initializer);
      if (ts.isShorthandPropertyAssignment(prop)) return false;
      if (ts.isSpreadAssignment(prop)) return hasSideEffects(prop.expression);
      // Method/accessor declarations are side-effect-free as definitions
      return false;
    });
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.some((span) => hasSideEffects(span.expression));
  }

  return false;
}
