import { isAssignmentKind } from "ts-api-utils";
import ts from "typescript";

export const SideEffectOptions = {
  None: 0,
  AssumeTaggedTemplatePure: 1,
  AssumeConstructorPure: 2,
  ConsiderIdentityMutating: 4,
  AssumePropertyAccessPure: 8,
} as const;

/**
 * Bitwise flag set for side effect assumptions.
 * Combine flags using bitwise OR: `SideEffectOptions.AssumeTaggedTemplatePure | SideEffectOptions.AssumeConstructorPure`
 */
export type SideEffectOptions = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/**
 * Syntax kinds that are transparent wrappers — the expression type cannot invoke getters.
 * These are peeled by `unwrapTransparent` by default.
 */
export const STATIC_TRANSPARENT_KINDS = Object.freeze(
  new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ParenthesizedExpression,
    ts.SyntaxKind.AsExpression,
    ts.SyntaxKind.TypeAssertionExpression,
    ts.SyntaxKind.NonNullExpression,
    ts.SyntaxKind.SatisfiesExpression,
  ]),
);

/**
 * Extended set of transparent kinds, including kinds with no type-observable effect.
 * Includes `STATIC_TRANSPARENT_KINDS` plus `VoidExpression`, `TypeOfExpression`, `SpreadElement`.
 */
export const EXTENDED_TRANSPARENT_KINDS = Object.freeze(
  new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ParenthesizedExpression,
    ts.SyntaxKind.AsExpression,
    ts.SyntaxKind.TypeAssertionExpression,
    ts.SyntaxKind.NonNullExpression,
    ts.SyntaxKind.SatisfiesExpression,
    ts.SyntaxKind.VoidExpression,
    ts.SyntaxKind.TypeOfExpression,
    ts.SyntaxKind.SpreadElement,
  ]),
);

/**
 * Unwraps transparent wrapper expressions until reaching a kind not in `kindSet`.
 *
 * By default, uses `STATIC_TRANSPARENT_KINDS` — peels type-only wrappers
 * (parens, type assertions, non-null, satisfies, as-expression).
 *
 * Pass `EXTENDED_TRANSPARENT_KINDS` to also peel `void`, `typeof`, and `SpreadElement`.
 */
export function unwrapTransparent(
  expr: ts.Expression,
  kindSet: ReadonlySet<ts.SyntaxKind> = STATIC_TRANSPARENT_KINDS,
): ts.Expression {
  let current = expr;
  while (kindSet.has(current.kind)) {
    const nextExpr = (
      current as
        | ts.ParenthesizedExpression
        | ts.AssertionExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
        | ts.VoidExpression
        | ts.TypeOfExpression
        | ts.SpreadElement
    ).expression;
    current = nextExpr;
  }
  return current;
}

/**
 * Returns true if the expression is a nil value: `null`, `undefined`, or `void expr`.
 *
 * Unwraps static transparent wrappers first (type-only wrappers that cannot
 * invoke getters).
 */
export function isNilExpression(node: ts.Expression): boolean {
  const unwrapped = unwrapTransparent(node);

  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }

  if (unwrapped.kind === ts.SyntaxKind.VoidExpression) {
    return true;
  }

  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    return true;
  }

  return false;
}

function queueTemplateSpans(templateNode: ts.TemplateExpression, queue: ts.Expression[]): void {
  for (const span of templateNode.templateSpans) queue.push(span.expression);
}

/**
 * Returns true if the expression could have side effects.
 *
 * By default, `new` and tagged templates are treated as side-effectful.
 * Pass `SideEffectOptions` flags to opt out of either assumption or to treat
 * property/element access as pure.
 */
export function hasSideEffects(
  node: ts.Expression,
  options: SideEffectOptions = SideEffectOptions.None,
): boolean {
  const queue: ts.Expression[] = [];
  let current: ts.Expression = node;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- intentional infinite loop
  while (true) {
    // Peel void, typeof, and spread — their side-effect profile depends only on the inner
    // expression, so hasSideEffects only cares about "could this do something?".
    current = unwrapTransparent(current, EXTENDED_TRANSPARENT_KINDS);

    switch (current.kind) {
      // --- Always side-effectful ---
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.DeleteExpression:
        return true;

      case ts.SyntaxKind.PropertyAccessExpression: {
        if (options & SideEffectOptions.AssumePropertyAccessPure) {
          const pa = current as ts.PropertyAccessExpression;
          queue.push(pa.expression);
          break;
        }
        // Property reads can invoke getters, so duplicating them is not semantics-preserving.
        return true;
      }

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
        if (options & SideEffectOptions.AssumePropertyAccessPure) {
          const ea = current as ts.ElementAccessExpression;
          queue.push(ea.expression, ea.argumentExpression);
          break;
        }
        return true;
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
          queueTemplateSpans(tte.template, queue);
        break;
      }

      case ts.SyntaxKind.TemplateExpression:
        queueTemplateSpans(current as ts.TemplateExpression, queue);
        break;

      // --- Containers: queue children ---
      case ts.SyntaxKind.ArrayLiteralExpression:
      case ts.SyntaxKind.ObjectLiteralExpression:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
        if (options & SideEffectOptions.ConsiderIdentityMutating) return true;
        if (current.kind === ts.SyntaxKind.ArrayLiteralExpression) {
          queue.push(...(current as ts.ArrayLiteralExpression).elements);
          break;
        }
        if (
          current.kind === ts.SyntaxKind.FunctionExpression ||
          current.kind === ts.SyntaxKind.ArrowFunction
        ) {
          break; // defining a function is pure
        }
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

      // Class expressions are always side-effectful because they may have:
      // - static field initializers with side effects
      // - decorators with side effects
      // - computed property names with side effects
      case ts.SyntaxKind.ClassExpression:
        return true;

      default:
        break;
    }

    if (queue.length === 0) return false;
    // queue.length > 0 is proven by the guard above — pop() is non-undefined here.
    // biome-ignore lint/style/noNonNullAssertion: length guard above proves pop() is non-undefined
    current = queue.pop()!;
  }
}
