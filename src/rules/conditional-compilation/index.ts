import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isExplicitAmbientTopLevelDeclaration } from "../../ast/ts-ambient";
import {
  type ConstantValue,
  type RuleFactory,
  resolveConditionalCompilationConfig,
  resolveConditionalCompilationStrict,
  resolveEffectiveStrict,
} from "../../config";
import {
  constantToLuaLiteral,
  evaluateLiteralExpression,
  evaluateResolvedExpression,
  isTruthy,
  unwrapCompileTimeExpression,
} from "./evaluator";
import {
  containsBreakOrReturn,
  containsConditionalCaseBreak,
  shouldPreserveFoldedBlock,
} from "./fold-safety";

export { evaluateCondition } from "./evaluator";

export const createVisitors: RuleFactory = (checker, config) => {
  const maybeResolved = resolveConditionalCompilationConfig(
    config.rules["conditional-compilation"],
  );
  if (maybeResolved === false) return {};
  // Rebind after guard so TypeScript narrows the type inside closures below
  const resolved = maybeResolved;

  // Resolve strict: per-rule override wins over global (same precedence as inline).
  const perRuleStrict = resolveConditionalCompilationStrict(
    config.rules["conditional-compilation"],
  );
  const effectiveStrict = resolveEffectiveStrict(config.strict ?? false, perRuleStrict);

  function createPartialFoldingWarning(node: ts.Node): ts.Diagnostic {
    return {
      file: node.getSourceFile(),
      start: node.getStart(),
      length: node.getWidth(),
      messageText:
        "conditional-compilation: condition references compile-time constants " +
        "but could not be fully resolved — the entire branch is preserved at runtime",
      category: effectiveStrict ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
      code: 90002,
      source: "tstl-optimize",
    };
  }

  function declarationIsAmbientCompileTimeConstant(declaration: ts.Declaration): boolean {
    if (!ts.isVariableDeclaration(declaration)) {
      return false;
    }
    const statement = declaration.parent.parent;
    if (!ts.isVariableStatement(statement)) {
      return false;
    }
    return isExplicitAmbientTopLevelDeclaration(statement);
  }

  function getTopLevelConstInitializer(declaration: ts.Declaration): ts.Expression | undefined {
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
      return undefined;
    }

    const list = declaration.parent;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) {
      return undefined;
    }

    return (list.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined;
  }

  function evaluateLocalConstant(expr: ts.Expression): ConstantValue | undefined {
    const unwrapped = unwrapCompileTimeExpression(expr);
    const literalValue = evaluateLiteralExpression(unwrapped);
    if (literalValue !== undefined) {
      return literalValue;
    }

    if (
      ts.isPrefixUnaryExpression(unwrapped) &&
      unwrapped.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(unwrapped.operand)
    ) {
      return -Number(unwrapped.operand.text);
    }

    return undefined;
  }

  function resolveConfiguredIdentifier(node: ts.Identifier): ConstantValue | undefined {
    const configured = resolved.get(node.text);
    if (configured === undefined) {
      return undefined;
    }

    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) {
      return configured;
    }

    const declarations = symbol.declarations;
    if (declarations === undefined) {
      return configured;
    }

    if (declarations.every(declarationIsAmbientCompileTimeConstant)) {
      return configured;
    }

    const localValues = declarations.map((d) => {
      const init = getTopLevelConstInitializer(d);
      return init ? evaluateLocalConstant(init) : undefined;
    });
    if (localValues.every((v) => v !== undefined)) {
      const first = localValues[0];
      return localValues.every((v) => v === first) ? first : undefined;
    }
    return undefined;
  }

  function evaluateScopedCondition(expr: ts.Expression): ConstantValue | undefined {
    return evaluateResolvedExpression(expr, resolveConfiguredIdentifier);
  }

  function referencesScopedConstants(expr: ts.Expression): boolean {
    const unwrapped = unwrapCompileTimeExpression(expr);

    if (ts.isIdentifier(unwrapped)) {
      return resolveConfiguredIdentifier(unwrapped) !== undefined;
    }

    if (ts.isPrefixUnaryExpression(unwrapped)) {
      return referencesScopedConstants(unwrapped.operand);
    }

    if (ts.isBinaryExpression(unwrapped)) {
      // Note: This does NOT short-circuit like evaluateResolvedExpression does on && and ||.
      // However, this divergence is safe: referencesScopedConstants is only called when
      // evaluateScopedCondition returns undefined, which cannot happen if a short-circuit
      // occurs (short-circuits return the short-circuit value, not undefined).
      return (
        referencesScopedConstants(unwrapped.left) || referencesScopedConstants(unwrapped.right)
      );
    }

    return false;
  }

  function tryFoldExpression(
    node: ts.Expression,
    context: tstl.TransformationContext,
  ): tstl.Expression {
    const value = evaluateScopedCondition(node);
    if (value !== undefined) {
      const lit = constantToLuaLiteral(value);
      tstl.setNodeOriginal(lit, node);
      return lit;
    }
    return context.superTransformExpression(node);
  }

  return {
    [ts.SyntaxKind.Identifier]: (
      node: ts.Identifier,
      context: tstl.TransformationContext,
    ): tstl.Expression => tryFoldExpression(node, context),

    [ts.SyntaxKind.BinaryExpression]: (
      node: ts.BinaryExpression,
      context: tstl.TransformationContext,
    ): tstl.Expression => tryFoldExpression(node, context),

    [ts.SyntaxKind.PrefixUnaryExpression]: (
      node: ts.PrefixUnaryExpression,
      context: tstl.TransformationContext,
    ): tstl.Expression => tryFoldExpression(node, context),

    [ts.SyntaxKind.IfStatement]: (
      node: ts.IfStatement,
      context: tstl.TransformationContext,
    ): tstl.Statement | tstl.Statement[] | undefined => {
      const value = evaluateScopedCondition(node.expression);
      if (value === undefined) {
        if (referencesScopedConstants(node.expression)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const branch = isTruthy(value) ? node.thenStatement : node.elseStatement;
      if (!branch) {
        return undefined;
      }

      return ts.isBlock(branch) && !shouldPreserveFoldedBlock(branch, node)
        ? branch.statements.flatMap((statement) => context.transformStatements(statement))
        : context.transformStatements(branch);
    },

    [ts.SyntaxKind.ConditionalExpression]: (
      node: ts.ConditionalExpression,
      context: tstl.TransformationContext,
    ): tstl.Expression => {
      const value = evaluateScopedCondition(node.condition);
      if (value === undefined) {
        if (referencesScopedConstants(node.condition)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformExpression(node);
      }

      return isTruthy(value)
        ? context.transformExpression(node.whenTrue)
        : context.transformExpression(node.whenFalse);
    },

    [ts.SyntaxKind.SwitchStatement]: (
      node: ts.SwitchStatement,
      context: tstl.TransformationContext,
    ): tstl.Statement | tstl.Statement[] | undefined => {
      const switchValue = evaluateScopedCondition(node.expression);
      if (switchValue === undefined) {
        if (referencesScopedConstants(node.expression)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const { clauses } = node.caseBlock;

      let hasUnresolvedCase = false;
      let hasUnresolvedCaseBeforeMatch = false;
      let matchIndex = -1;

      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (ts.isCaseClause(clause)) {
          const caseValue = evaluateScopedCondition(clause.expression);
          if (caseValue === undefined) {
            hasUnresolvedCase = true;
          } else if (matchIndex === -1 && caseValue === switchValue) {
            hasUnresolvedCaseBeforeMatch = hasUnresolvedCase;
            matchIndex = i;
          }
        }
      }

      // If no resolved case matches and there are unresolved cases,
      // we cannot determine the outcome at compile time. Preserve the switch.
      // Likewise, if a resolved match is preceded by an unresolved case,
      // that earlier clause could shadow the later match at runtime.
      if ((matchIndex === -1 && hasUnresolvedCase) || hasUnresolvedCaseBeforeMatch) {
        return context.superTransformStatements(node);
      }

      if (matchIndex === -1) {
        matchIndex = clauses.findIndex((c) => ts.isDefaultClause(c));
      }

      // No match and no default → strip entire switch
      if (matchIndex === -1) return undefined;

      // Collect statements respecting fallthrough semantics.
      // When a top-level statement is a Block, recurse into it and strip its
      // direct breaks — but never descend into loops or nested switches, since
      // their breaks belong to those constructs and must be preserved.
      function stripCaseBreaks(statement: ts.Block): ts.Block;
      function stripCaseBreaks(statement: ts.Statement): ts.Statement | undefined;
      function stripCaseBreaks(statement: ts.Statement): ts.Statement | undefined {
        if (ts.isBreakStatement(statement)) {
          return undefined;
        }

        if (
          ts.isBlock(statement) &&
          !ts.isIterationStatement(statement, false) &&
          !ts.isSwitchStatement(statement)
        ) {
          return ts.factory.updateBlock(
            statement,
            statement.statements.flatMap((child) => {
              const stripped = stripCaseBreaks(child);
              return stripped ? [stripped] : [];
            }),
          );
        }

        return statement;
      }

      function collectStrippingCaseBreaks(stmts: readonly ts.Statement[]): ts.Statement[] {
        const result: ts.Statement[] = [];
        for (const statement of stmts) {
          if (
            ts.isBlock(statement) &&
            !ts.isIterationStatement(statement, false) &&
            !ts.isSwitchStatement(statement)
          ) {
            const strippedBlock = stripCaseBreaks(statement);

            if (shouldPreserveFoldedBlock(strippedBlock, node)) {
              result.push(strippedBlock);
            } else {
              result.push(...strippedBlock.statements);
            }
            continue;
          }

          const stripped = stripCaseBreaks(statement);
          if (stripped !== undefined) {
            result.push(stripped);
          }
        }
        return result;
      }

      const collected: ts.Statement[] = [];
      for (let i = matchIndex; i < clauses.length; i++) {
        const stmts = clauses[i].statements;
        if (containsConditionalCaseBreak(stmts)) {
          return context.superTransformStatements(node);
        }
        collected.push(...collectStrippingCaseBreaks(stmts));
        if (containsBreakOrReturn(stmts)) break;
      }

      return collected.flatMap((s) => context.transformStatements(s));
    },
  };
};
