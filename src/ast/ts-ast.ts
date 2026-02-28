import { isAssignmentKind } from "ts-api-utils";
import ts from "typescript";

export const SideEffectOptions = {
  None: 0,
  AssumeTaggedTemplatePure: 1,
  AssumeConstructorPure: 2,
} as const;

export type SideEffectOptions = (typeof SideEffectOptions)[keyof typeof SideEffectOptions];

function queueTemplateSpans(templateNode: ts.TemplateExpression, queue: ts.Expression[]): void {
  for (const span of templateNode.templateSpans) queue.push(span.expression);
}

/**
 * Returns true if the expression could have side effects.
 *
 * By default, `new` and tagged templates are treated as side-effectful.
 * Pass `SideEffectOptions` flags to opt out of either assumption.
 */
export function hasSideEffects(
  node: ts.Expression,
  options: SideEffectOptions = SideEffectOptions.None,
): boolean {
  const queue: ts.Expression[] = [];
  let current: ts.Expression = node;
  while (true) {
    switch (current.kind) {
      // --- Always side-effectful ---
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.DeleteExpression:
        return true;

      // --- Transparent wrappers: unwrap .expression and continue ---
      case ts.SyntaxKind.TypeAssertionExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.NonNullExpression:
      case ts.SyntaxKind.VoidExpression:
      case ts.SyntaxKind.TypeOfExpression:
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.SpreadElement:
        current = (
          current as
            | ts.AssertionExpression
            | ts.SatisfiesExpression
            | ts.ParenthesizedExpression
            | ts.NonNullExpression
            | ts.VoidExpression
            | ts.TypeOfExpression
            | ts.PropertyAccessExpression
            | ts.SpreadElement
        ).expression;
        continue;

      case ts.SyntaxKind.PrefixUnaryExpression:
        switch ((current as ts.PrefixUnaryExpression).operator) {
          case ts.SyntaxKind.PlusPlusToken:
          case ts.SyntaxKind.MinusMinusToken:
            return true;
          default:
            current = (current as ts.PrefixUnaryExpression).operand;
            continue;
        }

      case ts.SyntaxKind.BinaryExpression: {
        const bin = current as ts.BinaryExpression;
        if (isAssignmentKind(bin.operatorToken.kind)) return true;
        queue.push(bin.right);
        current = bin.left;
        continue;
      }

      case ts.SyntaxKind.ElementAccessExpression: {
        const ea = current as ts.ElementAccessExpression;
        queue.push(ea.argumentExpression);
        current = ea.expression;
        continue;
      }

      case ts.SyntaxKind.ConditionalExpression: {
        const cond = current as ts.ConditionalExpression;
        queue.push(cond.whenTrue, cond.whenFalse);
        current = cond.condition;
        continue;
      }

      // --- Optionally side-effectful ---
      case ts.SyntaxKind.NewExpression: {
        if (!(options & SideEffectOptions.AssumeConstructorPure)) return true;
        const ne = current as ts.NewExpression;
        if (ne.arguments !== undefined) queue.push(...ne.arguments);
        current = ne.expression;
        continue;
      }

      case ts.SyntaxKind.TaggedTemplateExpression: {
        if (!(options & SideEffectOptions.AssumeTaggedTemplatePure)) return true;
        const tte = current as ts.TaggedTemplateExpression;
        queue.push(tte.tag);
        if (tte.template.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral)
          queueTemplateSpans(tte.template as ts.TemplateExpression, queue);
        break;
      }

      case ts.SyntaxKind.TemplateExpression:
        queueTemplateSpans(current as ts.TemplateExpression, queue);
        break;

      // --- Containers: queue children ---
      case ts.SyntaxKind.ArrayLiteralExpression:
        queue.push(...(current as ts.ArrayLiteralExpression).elements);
        break;

      case ts.SyntaxKind.ObjectLiteralExpression:
        for (const child of (current as ts.ObjectLiteralExpression).properties) {
          if (child.name?.kind === ts.SyntaxKind.ComputedPropertyName)
            queue.push(child.name.expression);
          switch (child.kind) {
            case ts.SyntaxKind.PropertyAssignment:
              queue.push(child.initializer);
              break;
            case ts.SyntaxKind.SpreadAssignment:
              queue.push(child.expression);
              break;
            // Shorthand ({x}), methods, getters, setters — defining these is pure.
            // Computed keys on any of them are already handled above.
            case ts.SyntaxKind.ShorthandPropertyAssignment:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
              break;
            default:
              return true;
          }
        }
        break;
    }

    if (queue.length === 0) return false;
    current = queue.pop() as ts.Expression;
  }
}
