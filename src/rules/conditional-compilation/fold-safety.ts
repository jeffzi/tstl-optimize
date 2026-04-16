import ts from "typescript";

/** Unwrap a Block into its inner statements; pass non-blocks through. */
function unwrapBlock(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

function blockRequiresScope(block: ts.Block): boolean {
  return block.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
    }

    return (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    );
  });
}

function hasFollowingSiblingStatements(statement: ts.Statement): boolean {
  const parent = statement.parent;
  const statements = ts.isSourceFile(parent) || ts.isBlock(parent) ? parent.statements : undefined;
  if (statements === undefined) {
    return true;
  }

  return statements.indexOf(statement) < statements.length - 1;
}

export function shouldPreserveFoldedBlock(block: ts.Block, owner: ts.Statement): boolean {
  return blockRequiresScope(block) && hasFollowingSiblingStatements(owner);
}

/**
 * Check if statements contain a direct (unconditional) break, return, or throw.
 * A break/return/throw inside an if statement is conditional and does not count.
 * Only direct statements at the top level count as stopping fallthrough.
 */
export function containsBreakOrReturn(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    if (
      ts.isBreakStatement(s) ||
      ts.isContinueStatement(s) ||
      ts.isReturnStatement(s) ||
      ts.isThrowStatement(s)
    ) {
      return true;
    }
    if (ts.isBlock(s)) {
      if (containsBreakOrReturn(s.statements)) return true;
    }
    // Do NOT recurse into if statements — breaks inside them are conditional
  }
  return false;
}

export function containsConditionalCaseBreak(
  statements: readonly ts.Statement[],
  topLevel = true,
): boolean {
  for (const statement of statements) {
    if (ts.isBreakStatement(statement)) {
      if (!topLevel) return true;
      continue;
    }

    if (ts.isBlock(statement)) {
      if (containsConditionalCaseBreak(statement.statements, topLevel)) return true;
      continue;
    }

    if (ts.isIfStatement(statement)) {
      if (containsConditionalCaseBreak(unwrapBlock(statement.thenStatement), false)) return true;
      if (
        statement.elseStatement &&
        containsConditionalCaseBreak(unwrapBlock(statement.elseStatement), false)
      ) {
        return true;
      }
      continue;
    }

    if (ts.isLabeledStatement(statement)) {
      // Defensive only: current TSTL reports Unsupported node kind
      // LabeledStatement for full transpiles, but if a label reaches this
      // analysis we must preserve the switch rather than expose bare breaks.
      if (containsConditionalCaseBreak([statement.statement], false)) return true;
      continue;
    }

    if (ts.isTryStatement(statement)) {
      if (containsConditionalCaseBreak(statement.tryBlock.statements, false)) return true;
      if (
        statement.catchClause &&
        containsConditionalCaseBreak(statement.catchClause.block.statements, false)
      ) {
        return true;
      }
      if (
        statement.finallyBlock &&
        containsConditionalCaseBreak(statement.finallyBlock.statements, false)
      ) {
        return true;
      }
    }
  }

  return false;
}
