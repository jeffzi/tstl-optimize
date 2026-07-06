// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/** Construct a clone via `create`, then copy `flags`/`line`/`column` from `original`. */
function cloneWith<T extends tstl.Node>(original: tstl.Node, create: () => T): T {
  const clone = create();
  clone.flags = original.flags;
  if (original.line !== undefined) {
    clone.line = original.line;
  }
  if (original.column !== undefined) {
    clone.column = original.column;
  }
  if ("leadingComments" in original) {
    type WithComments = {
      leadingComments?: Array<string | string[]>;
      trailingComments?: Array<string | string[]>;
    };
    const src = original as tstl.Node & WithComments;
    const dst = clone as T & WithComments;
    if (src.leadingComments !== undefined) dst.leadingComments = src.leadingComments.slice();
    if (src.trailingComments !== undefined) dst.trailingComments = src.trailingComments.slice();
  }
  return clone;
}

/** Deep-clone a TSTL Lua expression node, producing a structurally identical tree
 *  where no child node shares a reference with the original. */
export function deepCloneExpression(node: tstl.Expression): tstl.Expression {
  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const { left, right, operator } = node as tstl.BinaryExpression;
      return cloneWith(node, () =>
        tstl.createBinaryExpression(
          deepCloneExpression(left),
          deepCloneExpression(right),
          operator,
        ),
      );
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const { operand, operator } = node as tstl.UnaryExpression;
      return cloneWith(node, () =>
        tstl.createUnaryExpression(deepCloneExpression(operand), operator),
      );
    }
    case tstl.SyntaxKind.CallExpression: {
      const { expression, params } = node as tstl.CallExpression;
      return cloneWith(node, () =>
        tstl.createCallExpression(deepCloneExpression(expression), params.map(deepCloneExpression)),
      );
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const { prefixExpression, name, params } = node as tstl.MethodCallExpression;
      return cloneWith(node, () =>
        tstl.createMethodCallExpression(
          deepCloneExpression(prefixExpression),
          deepCloneExpression(name) as tstl.Identifier,
          params.map(deepCloneExpression),
        ),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const { table, index } = node as tstl.TableIndexExpression;
      return cloneWith(node, () =>
        tstl.createTableIndexExpression(deepCloneExpression(table), deepCloneExpression(index)),
      );
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return cloneWith(node, () =>
        tstl.createParenthesizedExpression(
          deepCloneExpression((node as tstl.ParenthesizedExpression).expression),
        ),
      );
    case tstl.SyntaxKind.TableExpression:
      return cloneWith(node, () =>
        tstl.createTableExpression(
          (node as tstl.TableExpression).fields.map((f) =>
            cloneWith(f, () =>
              tstl.createTableFieldExpression(
                deepCloneExpression(f.value),
                f.key ? deepCloneExpression(f.key) : undefined,
              ),
            ),
          ),
        ),
      );
    case tstl.SyntaxKind.ConditionalExpression: {
      const { condition, whenTrue, whenFalse } = node as tstl.ConditionalExpression;
      return cloneWith(node, () =>
        tstl.createConditionalExpression(
          deepCloneExpression(condition),
          deepCloneExpression(whenTrue),
          deepCloneExpression(whenFalse),
        ),
      );
    }
    case tstl.SyntaxKind.FunctionExpression: {
      const { params, dots, body, flags } = node as tstl.FunctionExpression;
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- body can be undefined at runtime despite the type declaration
      if (!body) {
        throw new Error("FunctionExpression body is required for deepCloneExpression");
      }
      const clonedParams = params?.map((p) => deepCloneExpression(p) as tstl.Identifier);
      const clonedDots = dots ? tstl.cloneNode(dots) : undefined;
      const clonedBody = cloneBlock(body);
      return cloneWith(node, () =>
        tstl.createFunctionExpression(clonedBody, clonedParams, clonedDots, flags),
      );
    }
    case tstl.SyntaxKind.Identifier: {
      const { text, symbolId, originalName, exportable } = node as tstl.Identifier;
      return cloneWith(node, () => {
        const cloned = tstl.createIdentifier(text, undefined, symbolId, originalName);
        cloned.exportable = exportable;
        return cloned;
      });
    }
    default:
      // Leaf nodes (StringLiteral, NumericLiteral, NilKeyword, BooleanLiteral,
      // DotsKeyword, ArgKeyword): shallow clone is fine since they have no children
      return cloneWith(node, () => tstl.cloneNode(node));
  }
}

/** Deep-clone a TSTL Lua statement node, producing a structurally identical tree
 *  where no child node shares a reference with the original. */
export function deepCloneStatement(stmt: tstl.Statement): tstl.Statement {
  switch (stmt.kind) {
    case tstl.SyntaxKind.DoStatement:
      return cloneWith(stmt, () =>
        tstl.createDoStatement(deepCloneStatements((stmt as tstl.DoStatement).statements)),
      );
    case tstl.SyntaxKind.VariableDeclarationStatement: {
      const { left, right } = stmt as tstl.VariableDeclarationStatement;
      return cloneWith(stmt, () =>
        tstl.createVariableDeclarationStatement(
          left.map((l) => deepCloneExpression(l) as tstl.Identifier),
          right?.map(deepCloneExpression),
        ),
      );
    }
    case tstl.SyntaxKind.AssignmentStatement: {
      const { left, right } = stmt as tstl.AssignmentStatement;
      return cloneWith(stmt, () =>
        tstl.createAssignmentStatement(
          left.map((l) => deepCloneExpression(l) as tstl.AssignmentLeftHandSideExpression),
          right.map(deepCloneExpression),
        ),
      );
    }
    case tstl.SyntaxKind.IfStatement:
      return cloneIfStatement(stmt as tstl.IfStatement);
    case tstl.SyntaxKind.WhileStatement: {
      const { body, condition } = stmt as tstl.WhileStatement;
      return cloneWith(stmt, () =>
        tstl.createWhileStatement(cloneBlock(body), deepCloneExpression(condition)),
      );
    }
    case tstl.SyntaxKind.RepeatStatement: {
      const { body, condition } = stmt as tstl.RepeatStatement;
      return cloneWith(stmt, () =>
        tstl.createRepeatStatement(cloneBlock(body), deepCloneExpression(condition)),
      );
    }
    case tstl.SyntaxKind.ForStatement: {
      const { body, controlVariable, controlVariableInitializer, limitExpression, stepExpression } =
        stmt as tstl.ForStatement;
      return cloneWith(stmt, () =>
        tstl.createForStatement(
          cloneBlock(body),
          deepCloneExpression(controlVariable) as tstl.Identifier,
          deepCloneExpression(controlVariableInitializer),
          deepCloneExpression(limitExpression),
          stepExpression ? deepCloneExpression(stepExpression) : undefined,
        ),
      );
    }
    case tstl.SyntaxKind.ForInStatement: {
      const { body, names, expressions } = stmt as tstl.ForInStatement;
      return cloneWith(stmt, () =>
        tstl.createForInStatement(
          cloneBlock(body),
          names.map((n) => deepCloneExpression(n) as tstl.Identifier),
          expressions.map(deepCloneExpression),
        ),
      );
    }
    case tstl.SyntaxKind.ReturnStatement: {
      const exprs = (stmt as tstl.ReturnStatement).expressions;
      /* oxlint-disable typescript/no-unnecessary-condition -- expressions can be undefined at runtime (bare return) */
      return cloneWith(stmt, () =>
        // biome-ignore lint/suspicious/noExplicitAny: expressions can be undefined at runtime despite the type declaration (bare return)
        (tstl.createReturnStatement as any)(exprs?.map(deepCloneExpression)),
      );
      /* oxlint-enable typescript/no-unnecessary-condition */
    }
    case tstl.SyntaxKind.ExpressionStatement:
      return cloneWith(stmt, () =>
        tstl.createExpressionStatement(
          deepCloneExpression((stmt as tstl.ExpressionStatement).expression),
        ),
      );
    case tstl.SyntaxKind.GotoStatement:
      return cloneWith(stmt, () => tstl.createGotoStatement((stmt as tstl.GotoStatement).label));
    case tstl.SyntaxKind.LabelStatement:
      return cloneWith(stmt, () => tstl.createLabelStatement((stmt as tstl.LabelStatement).name));
    default:
      return cloneWith(stmt, () => tstl.cloneNode(stmt));
  }
}

function cloneBlock(block: tstl.Block): tstl.Block {
  return cloneWith(block, () => tstl.createBlock(deepCloneStatements(block.statements)));
}

function cloneIfStatement(ifStmt: tstl.IfStatement): tstl.IfStatement {
  let elseBlock: tstl.Block | tstl.IfStatement | undefined;
  if (ifStmt.elseBlock) {
    if (tstl.isIfStatement(ifStmt.elseBlock)) {
      elseBlock = cloneIfStatement(ifStmt.elseBlock);
    } else {
      elseBlock = cloneBlock(ifStmt.elseBlock);
    }
  }
  return cloneWith(ifStmt, () =>
    tstl.createIfStatement(
      deepCloneExpression(ifStmt.condition),
      cloneBlock(ifStmt.ifBlock),
      elseBlock,
    ),
  );
}

/** Deep-clone an array of TSTL Lua statements. */
function deepCloneStatements(stmts: tstl.Statement[]): tstl.Statement[] {
  return stmts.map(deepCloneStatement);
}

/** Copy `line` and `column` from source node to target node.
 *
 *  - If `source.line` is defined, copies it to `target.line`
 *  - If `source.column` is defined, copies it to `target.column`
 *  - Does NOT copy `flags`, `leadingComments`, or `trailingComments`
 *  - Returns the mutated target (for chaining)
 */
export function withPositionFrom<T extends tstl.Node>(target: T, source: tstl.Node): T {
  if (source.line !== undefined) {
    target.line = source.line;
  }
  if (source.column !== undefined) {
    target.column = source.column;
  }
  return target;
}
