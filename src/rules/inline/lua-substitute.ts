// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression } from "../../ast/deep-clone";

/**
 * Recursively transform a Lua expression tree. `leafFn` is called on each node;
 * if it returns a value, that replaces the node (no further recursion).
 * Otherwise the default recursion rebuilds the node with mapped children.
 * Does not recurse into nested function bodies — they have their own scope.
 */
export function mapLuaExpression(
  node: tstl.Expression,
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Expression {
  const hit = leafFn(node);
  if (hit !== undefined) return hit;

  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);

  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return tstl.createBinaryExpression(recurse(bin.left), recurse(bin.right), bin.operator);
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const un = node as tstl.UnaryExpression;
      return tstl.createUnaryExpression(recurse(un.operand), un.operator);
    }
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return tstl.createCallExpression(recurse(call.expression), call.params.map(recurse));
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return tstl.createMethodCallExpression(
        recurse(method.prefixExpression),
        method.name,
        method.params.map(recurse),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return tstl.createTableIndexExpression(recurse(tbl.table), recurse(tbl.index));
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return tstl.createParenthesizedExpression(
        recurse((node as tstl.ParenthesizedExpression).expression),
      );
    case tstl.SyntaxKind.TableExpression: {
      const tblExpr = node as tstl.TableExpression;
      return tstl.createTableExpression(
        tblExpr.fields.map((field) =>
          tstl.createTableFieldExpression(
            recurse(field.value),
            field.key ? recurse(field.key) : undefined,
          ),
        ),
      );
    }
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return tstl.createConditionalExpression(
        recurse(cond.condition),
        recurse(cond.whenTrue),
        recurse(cond.whenFalse),
      );
    }
    case tstl.SyntaxKind.FunctionExpression: {
      const func = node as tstl.FunctionExpression;
      return tstl.createFunctionExpression(
        tstl.createBlock(mapLuaStatements(func.body.statements, leafFn)),
        func.params,
        func.dots,
        func.flags,
      );
    }
    default:
      return node;
  }
}

export function substituteParams(
  node: tstl.Expression,
  paramMap: Map<tstl.SymbolId, tstl.Expression>,
): tstl.Expression {
  return mapLuaExpression(node, (n) => {
    if (n.kind !== tstl.SyntaxKind.Identifier) return undefined;
    const id = n as tstl.Identifier;
    const mapped = id.symbolId !== undefined ? paramMap.get(id.symbolId) : undefined;
    return mapped ? deepCloneExpression(mapped) : undefined;
  });
}

/**
 * Recursively transform a Lua statement list. `leafFn` is called on each expression
 * node via `mapLuaExpression`; if it returns a value, that replaces the expression.
 * Produces new statement arrays without mutating originals.
 * @internal Exported for testing only.
 */
export function mapLuaStatements(
  statements: readonly tstl.Statement[],
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Statement[] {
  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);
  const recurseStmts = (stmts: readonly tstl.Statement[]) => mapLuaStatements(stmts, leafFn);

  function mapIfStatement(stmt: tstl.IfStatement): tstl.IfStatement {
    let elseBlock: tstl.Block | tstl.IfStatement | undefined;
    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        elseBlock = mapIfStatement(stmt.elseBlock);
      } else {
        elseBlock = tstl.createBlock(recurseStmts(stmt.elseBlock.statements));
      }
    }
    return tstl.createIfStatement(
      recurse(stmt.condition),
      tstl.createBlock(recurseStmts(stmt.ifBlock.statements)),
      elseBlock,
    );
  }

  return statements.map((stmt): tstl.Statement => {
    switch (stmt.kind) {
      case tstl.SyntaxKind.DoStatement: {
        const doStmt = stmt as tstl.DoStatement;
        return tstl.createDoStatement(recurseStmts(doStmt.statements));
      }
      case tstl.SyntaxKind.VariableDeclarationStatement: {
        const varDecl = stmt as tstl.VariableDeclarationStatement;
        return tstl.createVariableDeclarationStatement(
          // LHS identifiers in variable declarations are never parameters (canInline/canInlineStatements
          // rejects writes to params), so recurse preserves their Identifier kind here.
          varDecl.left.map((id) => recurse(id) as tstl.Identifier),
          varDecl.right?.map(recurse),
        );
      }
      case tstl.SyntaxKind.AssignmentStatement: {
        const assign = stmt as tstl.AssignmentStatement;
        return tstl.createAssignmentStatement(
          // Assignment LHS expressions (Identifier | TableIndexExpression) are not params
          // (isParamWritten rejects inline when params appear on LHS), so recurse is safe here.
          assign.left.map((l) => recurse(l) as tstl.AssignmentLeftHandSideExpression),
          assign.right.map(recurse),
        );
      }
      case tstl.SyntaxKind.IfStatement:
        return mapIfStatement(stmt as tstl.IfStatement);
      case tstl.SyntaxKind.WhileStatement: {
        const whileStmt = stmt as tstl.WhileStatement;
        return tstl.createWhileStatement(
          tstl.createBlock(recurseStmts(whileStmt.body.statements)),
          recurse(whileStmt.condition),
        );
      }
      case tstl.SyntaxKind.RepeatStatement: {
        const repeatStmt = stmt as tstl.RepeatStatement;
        return tstl.createRepeatStatement(
          tstl.createBlock(recurseStmts(repeatStmt.body.statements)),
          recurse(repeatStmt.condition),
        );
      }
      case tstl.SyntaxKind.ForStatement: {
        const forStmt = stmt as tstl.ForStatement;
        return tstl.createForStatement(
          tstl.createBlock(recurseStmts(forStmt.body.statements)),
          forStmt.controlVariable,
          recurse(forStmt.controlVariableInitializer),
          recurse(forStmt.limitExpression),
          forStmt.stepExpression ? recurse(forStmt.stepExpression) : undefined,
        );
      }
      case tstl.SyntaxKind.ForInStatement: {
        const forIn = stmt as tstl.ForInStatement;
        return tstl.createForInStatement(
          tstl.createBlock(recurseStmts(forIn.body.statements)),
          forIn.names,
          forIn.expressions.map(recurse),
        );
      }
      case tstl.SyntaxKind.ReturnStatement: {
        const ret = stmt as tstl.ReturnStatement;
        return tstl.createReturnStatement(ret.expressions.map(recurse));
      }
      case tstl.SyntaxKind.ExpressionStatement: {
        const exprStmt = stmt as tstl.ExpressionStatement;
        return tstl.createExpressionStatement(recurse(exprStmt.expression));
      }
      default:
        return tstl.cloneNode(stmt);
    }
  });
}

export function substituteParamsInStatements(
  statements: readonly tstl.Statement[],
  paramMap: ReadonlyMap<tstl.SymbolId, tstl.Expression>,
): tstl.Statement[] {
  return mapLuaStatements(statements, (n) => {
    if (n.kind !== tstl.SyntaxKind.Identifier) return undefined;
    const id = n as tstl.Identifier;
    const mapped = id.symbolId !== undefined ? paramMap.get(id.symbolId) : undefined;
    return mapped ? deepCloneExpression(mapped) : undefined;
  });
}

export function needsParentheses(node: tstl.Expression): boolean {
  return (
    tstl.isBinaryExpression(node) ||
    tstl.isUnaryExpression(node) ||
    tstl.isConditionalExpression(node)
  );
}
