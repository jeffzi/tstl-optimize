// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/** Deep-clone a TSTL Lua expression node, producing a structurally identical tree
 *  where no child node shares a reference with the original. */
export function deepCloneExpression(node: tstl.Expression): tstl.Expression {
  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const { left, right, operator } = node as tstl.BinaryExpression;
      return tstl.createBinaryExpression(
        deepCloneExpression(left),
        deepCloneExpression(right),
        operator,
      );
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const { operand, operator } = node as tstl.UnaryExpression;
      return tstl.createUnaryExpression(deepCloneExpression(operand), operator);
    }
    case tstl.SyntaxKind.CallExpression: {
      const { expression, params } = node as tstl.CallExpression;
      return tstl.createCallExpression(
        deepCloneExpression(expression),
        params.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const { prefixExpression, name, params } = node as tstl.MethodCallExpression;
      return tstl.createMethodCallExpression(
        deepCloneExpression(prefixExpression),
        deepCloneExpression(name) as tstl.Identifier,
        params.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const { table, index } = node as tstl.TableIndexExpression;
      return tstl.createTableIndexExpression(
        deepCloneExpression(table),
        deepCloneExpression(index),
      );
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return tstl.createParenthesizedExpression(
        deepCloneExpression((node as tstl.ParenthesizedExpression).expression),
      );
    case tstl.SyntaxKind.TableExpression:
      return tstl.createTableExpression(
        (node as tstl.TableExpression).fields.map((f) =>
          tstl.createTableFieldExpression(
            deepCloneExpression(f.value),
            f.key ? deepCloneExpression(f.key) : undefined,
          ),
        ),
      );
    case tstl.SyntaxKind.ConditionalExpression: {
      const { condition, whenTrue, whenFalse } = node as tstl.ConditionalExpression;
      return tstl.createConditionalExpression(
        deepCloneExpression(condition),
        deepCloneExpression(whenTrue),
        deepCloneExpression(whenFalse),
      );
    }
    case tstl.SyntaxKind.FunctionExpression: {
      const { params, dots, body, flags } = node as tstl.FunctionExpression;
      const clonedParams = params?.map((p) => deepCloneExpression(p) as tstl.Identifier);
      const clonedDots = dots ? (tstl.cloneNode(dots) as tstl.DotsLiteral) : undefined;
      const clonedBody = body
        ? tstl.createBlock(deepCloneStatements(body.statements))
        : tstl.createBlock([]);
      return tstl.createFunctionExpression(clonedBody, clonedParams, clonedDots, flags);
    }
    case tstl.SyntaxKind.Identifier: {
      const { text, symbolId, originalName, exportable } = node as tstl.Identifier;
      const cloned = tstl.createIdentifier(text, undefined, symbolId, originalName);
      cloned.exportable = exportable;
      return cloned;
    }
    default:
      // Leaf nodes (StringLiteral, NumericLiteral, NilKeyword, BooleanLiteral,
      // DotsKeyword, ArgKeyword): shallow clone is fine since they have no children
      return tstl.cloneNode(node);
  }
}

/** Deep-clone a TSTL Lua statement node, producing a structurally identical tree
 *  where no child node shares a reference with the original. */
export function deepCloneStatement(stmt: tstl.Statement): tstl.Statement {
  switch (stmt.kind) {
    case tstl.SyntaxKind.DoStatement:
      return tstl.createDoStatement(deepCloneStatements((stmt as tstl.DoStatement).statements));
    case tstl.SyntaxKind.VariableDeclarationStatement: {
      const { left, right } = stmt as tstl.VariableDeclarationStatement;
      return tstl.createVariableDeclarationStatement(
        left.map((l) => deepCloneExpression(l) as tstl.Identifier),
        right?.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.AssignmentStatement: {
      const { left, right } = stmt as tstl.AssignmentStatement;
      return tstl.createAssignmentStatement(
        left.map((l) => deepCloneExpression(l) as tstl.AssignmentLeftHandSideExpression),
        right.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.IfStatement:
      return cloneIfStatement(stmt as tstl.IfStatement);
    case tstl.SyntaxKind.WhileStatement: {
      const { body, condition } = stmt as tstl.WhileStatement;
      return tstl.createWhileStatement(
        tstl.createBlock(deepCloneStatements(body.statements)),
        deepCloneExpression(condition),
      );
    }
    case tstl.SyntaxKind.RepeatStatement: {
      const { body, condition } = stmt as tstl.RepeatStatement;
      return tstl.createRepeatStatement(
        tstl.createBlock(deepCloneStatements(body.statements)),
        deepCloneExpression(condition),
      );
    }
    case tstl.SyntaxKind.ForStatement: {
      const { body, controlVariable, controlVariableInitializer, limitExpression, stepExpression } =
        stmt as tstl.ForStatement;
      return tstl.createForStatement(
        tstl.createBlock(deepCloneStatements(body.statements)),
        deepCloneExpression(controlVariable) as tstl.Identifier,
        deepCloneExpression(controlVariableInitializer),
        deepCloneExpression(limitExpression),
        stepExpression ? deepCloneExpression(stepExpression) : undefined,
      );
    }
    case tstl.SyntaxKind.ForInStatement: {
      const { body, names, expressions } = stmt as tstl.ForInStatement;
      return tstl.createForInStatement(
        tstl.createBlock(deepCloneStatements(body.statements)),
        names.map((n) => deepCloneExpression(n) as tstl.Identifier),
        expressions.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.ReturnStatement:
      return tstl.createReturnStatement(
        (stmt as tstl.ReturnStatement).expressions.map(deepCloneExpression),
      );
    case tstl.SyntaxKind.ExpressionStatement:
      return tstl.createExpressionStatement(
        deepCloneExpression((stmt as tstl.ExpressionStatement).expression),
      );
    case tstl.SyntaxKind.GotoStatement:
      return tstl.createGotoStatement((stmt as tstl.GotoStatement).label);
    case tstl.SyntaxKind.LabelStatement:
      return tstl.createLabelStatement((stmt as tstl.LabelStatement).name);
    default:
      return tstl.cloneNode(stmt);
  }
}

function cloneIfStatement(ifStmt: tstl.IfStatement): tstl.IfStatement {
  let elseBlock: tstl.Block | tstl.IfStatement | undefined;
  if (ifStmt.elseBlock) {
    if (tstl.isIfStatement(ifStmt.elseBlock)) {
      elseBlock = cloneIfStatement(ifStmt.elseBlock);
    } else {
      elseBlock = tstl.createBlock(deepCloneStatements(ifStmt.elseBlock.statements));
    }
  }
  return tstl.createIfStatement(
    deepCloneExpression(ifStmt.condition),
    tstl.createBlock(deepCloneStatements(ifStmt.ifBlock.statements)),
    elseBlock,
  );
}

/** Deep-clone an array of TSTL Lua statements. */
export function deepCloneStatements(stmts: tstl.Statement[]): tstl.Statement[] {
  return stmts.map(deepCloneStatement);
}
