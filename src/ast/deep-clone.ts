// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/** Deep-clone a TSTL Lua expression node, producing a structurally identical tree
 *  where no child node shares a reference with the original. */
export function deepCloneExpression(node: tstl.Expression): tstl.Expression {
  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return tstl.createBinaryExpression(
        deepCloneExpression(bin.left),
        deepCloneExpression(bin.right),
        bin.operator,
      );
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const un = node as tstl.UnaryExpression;
      return tstl.createUnaryExpression(deepCloneExpression(un.operand), un.operator);
    }
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return tstl.createCallExpression(
        deepCloneExpression(call.expression),
        call.params.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return tstl.createMethodCallExpression(
        deepCloneExpression(method.prefixExpression),
        deepCloneExpression(method.name) as tstl.Identifier,
        method.params.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return tstl.createTableIndexExpression(
        deepCloneExpression(tbl.table),
        deepCloneExpression(tbl.index),
      );
    }
    case tstl.SyntaxKind.ParenthesizedExpression: {
      const paren = node as tstl.ParenthesizedExpression;
      return tstl.createParenthesizedExpression(deepCloneExpression(paren.expression));
    }
    case tstl.SyntaxKind.TableExpression: {
      const tblExpr = node as tstl.TableExpression;
      return tstl.createTableExpression(
        tblExpr.fields.map((f) =>
          tstl.createTableFieldExpression(
            deepCloneExpression(f.value),
            f.key ? deepCloneExpression(f.key) : undefined,
          ),
        ),
      );
    }
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return tstl.createConditionalExpression(
        deepCloneExpression(cond.condition),
        deepCloneExpression(cond.whenTrue),
        deepCloneExpression(cond.whenFalse),
      );
    }
    case tstl.SyntaxKind.FunctionExpression: {
      const func = node as tstl.FunctionExpression;
      const clonedParams = func.params?.map(
        (p) => deepCloneExpression(p) as tstl.Identifier,
      );
      const clonedDots = func.dots ? (tstl.cloneNode(func.dots) as tstl.DotsLiteral) : undefined;
      const clonedBody = tstl.createBlock(deepCloneStatements(func.body.statements));
      return tstl.createFunctionExpression(
        clonedBody,
        clonedParams,
        clonedDots,
        func.flags,
      );
    }
    case tstl.SyntaxKind.Identifier: {
      const ident = node as tstl.Identifier;
      const cloned = tstl.createIdentifier(
        ident.text,
        undefined,
        ident.symbolId,
        ident.originalName,
      );
      cloned.exportable = ident.exportable;
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
    case tstl.SyntaxKind.DoStatement: {
      const doStmt = stmt as tstl.DoStatement;
      return tstl.createDoStatement(deepCloneStatements(doStmt.statements));
    }
    case tstl.SyntaxKind.VariableDeclarationStatement: {
      const varDecl = stmt as tstl.VariableDeclarationStatement;
      return tstl.createVariableDeclarationStatement(
        varDecl.left.map((l) => deepCloneExpression(l) as tstl.Identifier),
        varDecl.right?.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.AssignmentStatement: {
      const assign = stmt as tstl.AssignmentStatement;
      return tstl.createAssignmentStatement(
        assign.left.map(
          (l) =>
            deepCloneExpression(l) as tstl.AssignmentLeftHandSideExpression,
        ),
        assign.right.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.IfStatement: {
      return cloneIfStatement(stmt as tstl.IfStatement);
    }
    case tstl.SyntaxKind.WhileStatement: {
      const whileStmt = stmt as tstl.WhileStatement;
      return tstl.createWhileStatement(
        tstl.createBlock(deepCloneStatements(whileStmt.body.statements)),
        deepCloneExpression(whileStmt.condition),
      );
    }
    case tstl.SyntaxKind.RepeatStatement: {
      const repeatStmt = stmt as tstl.RepeatStatement;
      return tstl.createRepeatStatement(
        tstl.createBlock(deepCloneStatements(repeatStmt.body.statements)),
        deepCloneExpression(repeatStmt.condition),
      );
    }
    case tstl.SyntaxKind.ForStatement: {
      const forStmt = stmt as tstl.ForStatement;
      return tstl.createForStatement(
        tstl.createBlock(deepCloneStatements(forStmt.body.statements)),
        deepCloneExpression(forStmt.controlVariable) as tstl.Identifier,
        deepCloneExpression(forStmt.controlVariableInitializer),
        deepCloneExpression(forStmt.limitExpression),
        forStmt.stepExpression ? deepCloneExpression(forStmt.stepExpression) : undefined,
      );
    }
    case tstl.SyntaxKind.ForInStatement: {
      const forIn = stmt as tstl.ForInStatement;
      return tstl.createForInStatement(
        tstl.createBlock(deepCloneStatements(forIn.body.statements)),
        forIn.names.map((n) => deepCloneExpression(n) as tstl.Identifier),
        forIn.expressions.map(deepCloneExpression),
      );
    }
    case tstl.SyntaxKind.ReturnStatement: {
      const ret = stmt as tstl.ReturnStatement;
      return tstl.createReturnStatement(ret.expressions.map(deepCloneExpression));
    }
    case tstl.SyntaxKind.ExpressionStatement: {
      const exprStmt = stmt as tstl.ExpressionStatement;
      return tstl.createExpressionStatement(deepCloneExpression(exprStmt.expression));
    }
    case tstl.SyntaxKind.GotoStatement: {
      const gotoStmt = stmt as tstl.GotoStatement;
      return tstl.createGotoStatement(gotoStmt.label);
    }
    case tstl.SyntaxKind.LabelStatement: {
      const labelStmt = stmt as tstl.LabelStatement;
      return tstl.createLabelStatement(labelStmt.name);
    }
    case tstl.SyntaxKind.BreakStatement:
    case tstl.SyntaxKind.ContinueStatement:
      return tstl.cloneNode(stmt);
    default:
      // Safety fallback for unknown statement types
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
