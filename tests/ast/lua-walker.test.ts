// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { isLuaExprPure, isLuaRhsPure } from "../../src/ast/lua-ast";
import { walkStatements } from "../../src/ast/lua-walker";

function id(name: string): tstl.Identifier {
  return tstl.createIdentifier(name);
}

function num(value: number): tstl.NumericLiteral {
  return tstl.createNumericLiteral(value);
}

function str(value: string): tstl.StringLiteral {
  return tstl.createStringLiteral(value);
}

function assertNode<T extends tstl.Node>(
  node: tstl.Node,
  guard: (n: tstl.Node) => n is T,
): asserts node is T {
  if (!guard(node)) throw new Error(`Unexpected node kind: ${node.kind}`);
}

function collectExprs(statements: tstl.Statement[], shallow?: boolean): tstl.Expression[] {
  const visited: tstl.Expression[] = [];
  walkStatements(statements, {
    shallow,
    expr: (expr) => {
      visited.push(expr);
    },
  });
  return visited;
}

describe("walkStatements", () => {
  describe("when visiting expressions", () => {
    it("visits expressions in variable declarations", () => {
      const stmts: tstl.Statement[] = [
        tstl.createVariableDeclarationStatement(id("x"), num(1)),
        tstl.createVariableDeclarationStatement(id("y"), num(2)),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs.filter(tstl.isNumericLiteral).map((e) => e.value)).toStrictEqual([1, 2]);
    });

    it("visits assignment expression children", () => {
      const tableIdx = tstl.createTableIndexExpression(id("arr"), str("key"));
      const stmts: tstl.Statement[] = [tstl.createAssignmentStatement(tableIdx, num(42))];
      const exprs = collectExprs(stmts);
      const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
      expect(identifiers).toContain("arr");
      expect(exprs.filter(tstl.isNumericLiteral).map((e) => e.value)).toContain(42);
    });

    it("visits plain Identifier assignment targets", () => {
      const stmts: tstl.Statement[] = [tstl.createAssignmentStatement(id("x"), num(1))];
      const exprs = collectExprs(stmts);
      const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
      expect(identifiers).toContain("x");
    });

    it("visits condition, if-block, and else-block expressions", () => {
      const stmts: tstl.Statement[] = [
        tstl.createIfStatement(
          id("cond"),
          tstl.createBlock([tstl.createExpressionStatement(num(1))]),
          tstl.createBlock([tstl.createExpressionStatement(num(2))]),
        ),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs).toHaveLength(3);
    });

    it.each([
      {
        name: "for statement",
        createStatements: (): tstl.Statement[] => [
          tstl.createForStatement(
            tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
            id("i"),
            num(0),
            num(10),
            num(1),
          ),
        ],
        assertVisited: (exprs: tstl.Expression[]) => {
          const numericValues = exprs.filter(tstl.isNumericLiteral).map((expr) => expr.value);
          expect(numericValues).toContain(0);
          expect(numericValues).toContain(10);
          expect(numericValues).toContain(1);
          expect(exprs.filter(tstl.isStringLiteral).map((e) => e.value)).toContain("body");
        },
      },
      {
        name: "for-in statement",
        createStatements: (): tstl.Statement[] => [
          tstl.createForInStatement(
            tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
            [id("k")],
            [tstl.createCallExpression(id("pairs"), [id("t")])],
          ),
        ],
        assertVisited: (exprs: tstl.Expression[]) => {
          const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
          expect(identifiers).toContain("pairs");
          expect(identifiers).toContain("t");
          expect(exprs.filter(tstl.isStringLiteral).map((e) => e.value)).toContain("body");
        },
      },
      {
        name: "while statement",
        createStatements: (): tstl.Statement[] => [
          tstl.createWhileStatement(
            tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
            id("cond"),
          ),
        ],
        assertVisited: (exprs: tstl.Expression[]) => {
          expect(exprs.filter(tstl.isIdentifier).map((e) => e.text)).toContain("cond");
          expect(exprs.filter(tstl.isStringLiteral).map((e) => e.value)).toContain("body");
        },
      },
    ])("visits all relevant expressions in $name", ({ createStatements, assertVisited }) => {
      const exprs = collectExprs(createStatements());
      assertVisited(exprs);
    });

    it("visits return statement expressions", () => {
      const stmts: tstl.Statement[] = [tstl.createReturnStatement([num(1), num(2)])];
      const exprs = collectExprs(stmts);
      expect(exprs.filter(tstl.isNumericLiteral).map((e) => e.value)).toStrictEqual([1, 2]);
    });

    it("visits expression statement", () => {
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(num(42))];
      const exprs = collectExprs(stmts);
      expect(exprs).toHaveLength(1);
    });

    it("visits do-statement body", () => {
      const stmts: tstl.Statement[] = [
        tstl.createDoStatement([tstl.createExpressionStatement(num(1))]),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs).toHaveLength(1);
    });

    it("visits table field keys before values", () => {
      const field = tstl.createTableFieldExpression(id("valueExpr"), id("keyExpr"));
      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(tstl.createTableExpression([field])),
      ];

      const identifiers = collectExprs(stmts)
        .filter(tstl.isIdentifier)
        .map((expr) => expr.text);

      expect(identifiers).toStrictEqual(["keyExpr", "valueExpr"]);
    });
  });

  describe("when using the replace callback", () => {
    it("mutates single expression in variable declaration", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            replace(num(99));
          }
        },
      });
      const decl = stmts[0];
      assertNode(decl, tstl.isVariableDeclarationStatement);
      const val = decl.right?.[0];
      expect(val && tstl.isNumericLiteral(val) && val.value).toBe(99);
    });

    it("mutates array elements in return statement", () => {
      const stmts: tstl.Statement[] = [tstl.createReturnStatement([num(1), num(2), num(3)])];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 2) {
            replace(num(20));
          }
        },
      });
      const ret = stmts[0];
      assertNode(ret, tstl.isReturnStatement);
      expect(tstl.isNumericLiteral(ret.expressions[1]) && ret.expressions[1].value).toBe(20);
    });

    it("mutates expression in expression statement", () => {
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(id("old"))];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "old") {
            replace(id("new"));
          }
        },
      });
      const es = stmts[0];
      assertNode(es, tstl.isExpressionStatement);
      expect(tstl.isIdentifier(es.expression) && es.expression.text).toBe("new");
    });

    it("mutates binary expression operands", () => {
      const bin = tstl.createBinaryExpression(num(1), num(2), tstl.SyntaxKind.AdditionOperator);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(bin)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) replace(num(10));
          if (tstl.isNumericLiteral(expr) && expr.value === 2) replace(num(20));
        },
      });
      expect(tstl.isNumericLiteral(bin.left) && bin.left.value).toBe(10);
      expect(tstl.isNumericLiteral(bin.right) && bin.right.value).toBe(20);
    });

    it("mutates unary expression operand", () => {
      const unary = tstl.createUnaryExpression(num(5), tstl.SyntaxKind.NegationOperator);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(unary)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr)) replace(num(99));
        },
      });
      expect(tstl.isNumericLiteral(unary.operand) && unary.operand.value).toBe(99);
    });

    it("mutates call expression replaceable children", () => {
      const call = tstl.createCallExpression(id("fn"), [num(1), num(2)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "fn") replace(id("replaced"));
          if (tstl.isNumericLiteral(expr) && expr.value === 1) replace(num(10));
        },
      });
      expect(tstl.isIdentifier(call.expression) && call.expression.text).toBe("replaced");
      expect(tstl.isNumericLiteral(call.params[0]) && call.params[0].value).toBe(10);
    });

    it("mutates method call expression replaceable children", () => {
      const method = tstl.createMethodCallExpression(id("obj"), id("method"), [num(1)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(method)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "obj") replace(id("self"));
          if (tstl.isNumericLiteral(expr)) replace(num(42));
        },
      });
      expect(tstl.isIdentifier(method.prefixExpression) && method.prefixExpression.text).toBe(
        "self",
      );
      expect(tstl.isNumericLiteral(method.params[0]) && method.params[0].value).toBe(42);
    });

    it("mutates table index expression replaceable children", () => {
      const idx = tstl.createTableIndexExpression(id("tbl"), str("key"));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(idx)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "tbl") replace(id("other"));
          if (tstl.isStringLiteral(expr) && expr.value === "key") replace(str("idx"));
        },
      });
      expect(tstl.isIdentifier(idx.table) && idx.table.text).toBe("other");
      expect(tstl.isStringLiteral(idx.index) && idx.index.value).toBe("idx");
    });

    it("mutates table expression field value", () => {
      const field = tstl.createTableFieldExpression(num(1), str("k"));
      const tbl = tstl.createTableExpression([field]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(tbl)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr)) replace(num(99));
        },
      });
      expect(tstl.isNumericLiteral(field.value) && field.value.value).toBe(99);
    });

    it("mutates table expression field key", () => {
      const field = tstl.createTableFieldExpression(num(1), str("k"));
      const tbl = tstl.createTableExpression([field]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(tbl)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isStringLiteral(expr) && expr.value === "k") replace(str("newKey"));
        },
      });
      expect(field.key && tstl.isStringLiteral(field.key) && field.key.value).toBe("newKey");
    });

    it("mutates parenthesized expression", () => {
      const paren = tstl.createParenthesizedExpression(num(5));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(paren)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr)) replace(num(77));
        },
      });
      expect(tstl.isNumericLiteral(paren.expression) && paren.expression.value).toBe(77);
    });

    it("mutates conditional expression replaceable children", () => {
      const cond = tstl.createConditionalExpression(id("c"), num(1), num(2));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(cond)];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "c") replace(id("flag"));
          if (tstl.isNumericLiteral(expr) && expr.value === 1) replace(num(10));
          if (tstl.isNumericLiteral(expr) && expr.value === 2) replace(num(20));
        },
      });
      expect(tstl.isIdentifier(cond.condition) && cond.condition.text).toBe("flag");
      expect(tstl.isNumericLiteral(cond.whenTrue) && cond.whenTrue.value).toBe(10);
      expect(tstl.isNumericLiteral(cond.whenFalse) && cond.whenFalse.value).toBe(20);
    });

    it("mutates assignment statement replaceable children", () => {
      const lhs = tstl.createTableIndexExpression(id("arr"), str("idx"));
      const stmt = tstl.createAssignmentStatement(lhs, num(5));
      const stmts: tstl.Statement[] = [stmt];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "arr") replace(id("buf"));
          if (tstl.isStringLiteral(expr) && expr.value === "idx") replace(str("pos"));
          if (tstl.isNumericLiteral(expr) && expr.value === 5) replace(num(42));
        },
      });
      const left = stmt.left[0];
      assertNode(left, tstl.isTableIndexExpression);
      expect(tstl.isIdentifier(left.table) && left.table.text).toBe("buf");
      expect(tstl.isStringLiteral(left.index) && left.index.value).toBe("pos");
      expect(tstl.isNumericLiteral(stmt.right[0]) && stmt.right[0].value).toBe(42);
    });

    it("mutates if-statement condition", () => {
      const ifStmt = tstl.createIfStatement(id("c"), tstl.createBlock([]));
      const stmts: tstl.Statement[] = [ifStmt];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "c") replace(id("flag"));
        },
      });
      expect(tstl.isIdentifier(ifStmt.condition) && ifStmt.condition.text).toBe("flag");
    });

    it("mutates while-statement condition", () => {
      const whileStmt = tstl.createWhileStatement(tstl.createBlock([]), id("running"));
      const stmts: tstl.Statement[] = [whileStmt];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "running") replace(id("done"));
        },
      });
      expect(tstl.isIdentifier(whileStmt.condition) && whileStmt.condition.text).toBe("done");
    });

    it("mutates repeat-statement condition", () => {
      const repeatStmt = tstl.createRepeatStatement(tstl.createBlock([]), id("ready"));
      const stmts: tstl.Statement[] = [repeatStmt];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "ready") replace(id("done"));
        },
      });
      expect(tstl.isIdentifier(repeatStmt.condition) && repeatStmt.condition.text).toBe("done");
    });

    it("mutates for-statement replaceable children", () => {
      const forStmt = tstl.createForStatement(
        tstl.createBlock([]),
        id("i"),
        num(0),
        num(10),
        num(1),
      );
      const stmts: tstl.Statement[] = [forStmt];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 0) replace(num(1));
          if (tstl.isNumericLiteral(expr) && expr.value === 10) replace(num(100));
          if (tstl.isNumericLiteral(expr) && expr.value === 1) replace(num(2));
        },
      });
      expect(
        tstl.isNumericLiteral(forStmt.controlVariableInitializer) &&
          forStmt.controlVariableInitializer.value,
      ).toBe(1);
      expect(tstl.isNumericLiteral(forStmt.limitExpression) && forStmt.limitExpression.value).toBe(
        100,
      );
      expect(
        forStmt.stepExpression &&
          tstl.isNumericLiteral(forStmt.stepExpression) &&
          forStmt.stepExpression.value,
      ).toBe(2);
    });

    it("mutates for-in statement expressions", () => {
      const forIn = tstl.createForInStatement(
        tstl.createBlock([]),
        [id("k")],
        [tstl.createCallExpression(id("pairs"), [id("t")])],
      );
      const stmts: tstl.Statement[] = [forIn];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "t") replace(id("myTable"));
        },
      });
      const call = forIn.expressions[0];
      assertNode(call, tstl.isCallExpression);
      expect(tstl.isIdentifier(call.params[0]) && call.params[0].text).toBe("myTable");
    });

    it("mutates top-level for-in expressions", () => {
      const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("iter")]);
      const stmts: tstl.Statement[] = [forIn];

      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isIdentifier(expr) && expr.text === "iter") {
            replace(id("nextIter"));
          }
        },
      });

      expect(forIn.expressions).toStrictEqual([id("nextIter")]);
    });
  });

  describe("when skip() is called from expr hook", () => {
    it("control.skip() from expr hook skips children", () => {
      const inner = tstl.createCallExpression(id("inner"), [num(1)]);
      const outer = tstl.createCallExpression(inner, []);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(outer)];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isCallExpression(expr)) {
            const callee = expr.expression;
            if (tstl.isCallExpression(callee)) {
              visited.push("outer");
              control.skip(); // skip children — inner call and num(1) not visited
              return;
            }
            visited.push("inner");
          }
        },
      });
      expect(visited).toStrictEqual(["outer"]);
    });
  });

  describe("when using the statement hook", () => {
    it("control.skip() skips entire statement", () => {
      const stmts: tstl.Statement[] = [
        tstl.createVariableDeclarationStatement(id("x"), num(1)),
        tstl.createVariableDeclarationStatement(id("y"), num(2)),
      ];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) visited.push(expr.value);
        },
        stmt: (stmt, control) => {
          // Skip the first declaration
          if (
            tstl.isVariableDeclarationStatement(stmt) &&
            stmt.left[0] &&
            tstl.isIdentifier(stmt.left[0]) &&
            stmt.left[0].text === "x"
          ) {
            control.skip();
          }
        },
      });
      expect(visited).toStrictEqual([2]);
    });

    it("skips nested blocks when stmt hook calls skip()", () => {
      const inner = tstl.createExpressionStatement(num(42));
      const stmts: tstl.Statement[] = [tstl.createDoStatement([inner])];
      const visited: tstl.Expression[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          visited.push(expr);
        },
        stmt: (_stmt, control) => {
          control.skip();
        },
      });
      expect(visited).toHaveLength(0);
    });
  });

  describe("when shallow mode is enabled", () => {
    it("skips FunctionExpression bodies when shallow=true", () => {
      const funcBody = tstl.createBlock([tstl.createExpressionStatement(num(42))]);
      const funcExpr = tstl.createFunctionExpression(funcBody, []);
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("fn"), funcExpr)];

      const deep = collectExprs(stmts, false);
      const shallow = collectExprs(stmts, true);

      // Deep visits the function expression AND its body (42)
      expect(deep.filter(tstl.isNumericLiteral)).toHaveLength(1);
      // Shallow visits the function expression but NOT its body
      expect(shallow.filter(tstl.isNumericLiteral)).toHaveLength(0);
    });
  });

  describe("when walking a repeat statement", () => {
    it("visits body before condition", () => {
      const stmts: tstl.Statement[] = [
        tstl.createRepeatStatement(
          tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
          str("cond"),
        ),
      ];
      const order: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isStringLiteral(expr)) order.push(expr.value);
        },
      });
      expect(order).toStrictEqual(["body", "cond"]);
    });
  });

  describe("when controlling traversal", () => {
    it("stop() in expr hook halts all traversal", () => {
      const stmts: tstl.Statement[] = [
        tstl.createVariableDeclarationStatement(id("x"), num(1)),
        tstl.createVariableDeclarationStatement(id("y"), num(2)),
      ];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() in stmt hook halts all traversal", () => {
      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(num(1)),
        tstl.createExpressionStatement(num(2)),
      ];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) visited.push(expr.value);
        },
        stmt: (_stmt, control) => {
          control.stop();
        },
      });
      expect(visited).toStrictEqual([]);
    });

    it("skip() in expr hook skips descendants but continues siblings", () => {
      // call(nested()) — skip on outer call, inner should not be visited
      const inner = tstl.createCallExpression(id("inner"), [num(1)]);
      const outer = tstl.createCallExpression(inner, []);
      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(outer),
        tstl.createExpressionStatement(num(99)),
      ];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isCallExpression(expr)) {
            visited.push("call");
            control.skip();
          } else if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
        },
      });
      // Outer call skipped (inner not visited), but sibling num(99) is visited
      expect(visited).toStrictEqual(["call", "num:99"]);
    });

    it("skip() in stmt hook skips statement body but continues siblings", () => {
      const ifStmt = tstl.createIfStatement(
        id("cond"),
        tstl.createBlock([tstl.createExpressionStatement(num(42))]),
      );
      const stmts: tstl.Statement[] = [ifStmt, tstl.createExpressionStatement(num(99))];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) visited.push(expr.value);
        },
        stmt: (_stmt, control) => {
          if (tstl.isIfStatement(_stmt)) control.skip();
        },
      });
      // if-body (42) and condition (cond) skipped, sibling 99 visited
      expect(visited).toStrictEqual([99]);
    });
  });

  describe("when guardDepth tracking is enabled", () => {
    it("increments guardDepth for and/or RHS and if branches", () => {
      const hooks = {
        guardDepth: 0,
        expr: (expr: tstl.Expression) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(`${expr.text}@${hooks.guardDepth}`);
          } else if (tstl.isNumericLiteral(expr)) {
            visited.push(`${expr.value}@${hooks.guardDepth}`);
          }
        },
      };
      const visited: string[] = [];
      const guarded = tstl.createBinaryExpression(
        id("lhs"),
        id("rhs"),
        tstl.SyntaxKind.AndOperator,
      );
      const branch = tstl.createIfStatement(
        id("cond"),
        tstl.createBlock([tstl.createExpressionStatement(num(1))]),
        tstl.createBlock([tstl.createExpressionStatement(num(2))]),
      );

      walkStatements([tstl.createExpressionStatement(guarded), branch], hooks);

      expect(visited).toStrictEqual(["lhs@0", "rhs@1", "cond@0", "1@1", "2@1"]);
    });

    it("restores guardDepth when stop() fires in a conditional branch", () => {
      const hooks = {
        guardDepth: 0,
        expr: (
          expr: tstl.Expression,
          _replace: (n: tstl.Expression) => void,
          control: {
            stop(): void;
          },
        ) => {
          if (tstl.isNumericLiteral(expr)) {
            seenDepths.push(hooks.guardDepth);
            control.stop();
          }
        },
      };
      const seenDepths: number[] = [];
      const stmt = tstl.createExpressionStatement(
        tstl.createConditionalExpression(id("cond"), num(1), num(2)),
      );

      walkStatements([stmt], hooks);

      expect(seenDepths).toStrictEqual([1]);
      expect(hooks.guardDepth).toBe(0);
    });

    it("restores guardDepth after full conditional expression traversal", () => {
      // ConditionalExpression fully traversed (no stop): guardDepth++ before whenTrue,
      // guardDepth-- (line 129) after whenFalse. Verify depth is back to 0.
      const hooks = {
        guardDepth: 0,
        expr: (_expr: tstl.Expression) => {},
      };
      const stmt = tstl.createExpressionStatement(
        tstl.createConditionalExpression(id("c"), num(1), num(2)),
      );

      walkStatements([stmt], hooks);

      expect(hooks.guardDepth).toBe(0);
    });

    it("restores guardDepth when stop() fires inside an if block", () => {
      const hooks = {
        guardDepth: 0,
        expr: (
          expr: tstl.Expression,
          _replace: (n: tstl.Expression) => void,
          control: {
            stop(): void;
          },
        ) => {
          if (tstl.isNumericLiteral(expr)) {
            seenDepths.push(hooks.guardDepth);
            control.stop();
          }
        },
      };
      const seenDepths: number[] = [];
      const stmt = tstl.createIfStatement(
        id("cond"),
        tstl.createBlock([tstl.createExpressionStatement(num(1))]),
        tstl.createBlock([tstl.createExpressionStatement(num(2))]),
      );

      walkStatements([stmt], hooks);

      expect(seenDepths).toStrictEqual([1]);
      expect(hooks.guardDepth).toBe(0);
    });

    it("stops after visiting a for-step expression", () => {
      const stmt = tstl.createForStatement(
        tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
        id("i"),
        num(0),
        num(2),
        num(1),
      );
      const visited: string[] = [];

      walkStatements([stmt], {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push("step");
            control.stop();
          } else if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
        },
      });

      expect(visited).toStrictEqual(["step"]);
    });
  });

  describe("when stop() is called in specific expression contexts", () => {
    it("stop() inside binary expression halts before right operand", () => {
      const bin = tstl.createBinaryExpression(num(1), num(2), tstl.SyntaxKind.AdditionOperator);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(bin)];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside call expression halts before remaining params", () => {
      const call = tstl.createCallExpression(id("fn"), [num(1), num(2), num(3)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push(1);
            control.stop();
          } else if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside table index expression halts before index", () => {
      const idx = tstl.createTableIndexExpression(id("tbl"), str("key"));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(idx)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["tbl"]);
    });

    it("stop() inside conditional expression halts after whenTrue", () => {
      const cond = tstl.createConditionalExpression(id("c"), num(1), num(2));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(cond)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
            control.stop();
          } else if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
          }
        },
      });
      // Visits condition (c), then whenTrue (1) where stop fires, then not whenFalse (2)
      expect(visited).toStrictEqual(["id:c", "num:1"]);
    });

    it("stop() inside conditional expression halts after condition", () => {
      const cond = tstl.createConditionalExpression(id("c"), num(1), num(2));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(cond)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["id:c"]);
    });

    it("stop() inside if-statement halts before else block", () => {
      const ifStmt = tstl.createIfStatement(
        id("cond"),
        tstl.createBlock([tstl.createExpressionStatement(num(1))]),
        tstl.createBlock([tstl.createExpressionStatement(num(2))]),
      );
      const stmts: tstl.Statement[] = [ifStmt];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          }
        },
      });
      // if-block body (1) visited, stop fires, else-block (2) not visited
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside while condition halts before body", () => {
      const whileStmt = tstl.createWhileStatement(
        tstl.createBlock([tstl.createExpressionStatement(num(42))]),
        id("cond"),
      );
      const stmts: tstl.Statement[] = [whileStmt];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["cond"]);
    });

    it("stop() inside repeat body halts before condition", () => {
      const repeatStmt = tstl.createRepeatStatement(
        tstl.createBlock([tstl.createExpressionStatement(num(1))]),
        id("done"),
      );
      const stmts: tstl.Statement[] = [repeatStmt];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push("body");
            control.stop();
          }
        },
      });
      // Body visited, stop fires, condition not visited
      expect(visited).toStrictEqual(["body"]);
    });

    it("stop() inside for-statement init halts before limit", () => {
      const forStmt = tstl.createForStatement(
        tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
        id("i"),
        num(0),
        num(10),
      );
      const stmts: tstl.Statement[] = [forStmt];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 0) {
            visited.push("init");
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["init"]);
    });

    it("stop() inside for-statement limit halts before step and body", () => {
      const forStmt = tstl.createForStatement(
        tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
        id("i"),
        num(0),
        num(10),
        num(1),
      );
      const stmts: tstl.Statement[] = [forStmt];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 10) {
            visited.push("limit");
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["limit"]);
    });

    it("stop() inside for-in expressions halts before body", () => {
      const forIn = tstl.createForInStatement(
        tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
        [id("k")],
        [id("iter")],
      );
      const stmts: tstl.Statement[] = [forIn];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["iter"]);
    });

    it("stop() inside method call halts before remaining params", () => {
      const method = tstl.createMethodCallExpression(id("obj"), id("m"), [num(1), num(2)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(method)];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push(1);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() in first TableIndexExpression LHS table halts before second LHS", () => {
      // Multi-target assignment: arr["a"], tab["b"] = 1, 2
      // stop() fires when visiting "arr" (first lhs.table) → returns at line 158
      const lhs1 = tstl.createTableIndexExpression(id("arr"), str("a"));
      const lhs2 = tstl.createTableIndexExpression(id("tab"), str("b"));
      const stmt = tstl.createAssignmentStatement([lhs1, lhs2], [num(1), num(2)]);
      const visited: string[] = [];
      walkStatements([stmt], {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual(["arr"]);
    });

    it("stop() in first LHS index visit halts before second LHS (line 153)", () => {
      // Two TableIndexExpression LHS: arr["a"], tab["b"]
      // stop() fires in "a" (first lhs.index) → second LHS iteration hits stopped guard (line 153)
      const lhs1 = tstl.createTableIndexExpression(id("arr"), str("a"));
      const lhs2 = tstl.createTableIndexExpression(id("tab"), str("b"));
      const stmt = tstl.createAssignmentStatement([lhs1, lhs2], [num(1), num(2)]);
      const visited: string[] = [];
      walkStatements([stmt], {
        expr: (expr, _replace, control) => {
          if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          } else if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
          }
        },
      });
      // arr (lhs1.table), then "a" (lhs1.index, stop fires); lhs2 never reached
      expect(visited).toStrictEqual(["arr", "a"]);
    });

    it("stop() in TableExpression field key halts before field value (line 100)", () => {
      // Table with a key: { [key] = value } — stop() on key → value skipped (line 100 guard)
      const field = tstl.createTableFieldExpression(str("value"), id("key"));
      const tbl = tstl.createTableExpression([field]);
      const visited: string[] = [];
      walkStatements([tstl.createExpressionStatement(tbl)], {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr) && expr.text === "key") {
            visited.push("key");
            control.stop();
          } else if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
        },
      });
      expect(visited).toStrictEqual(["key"]);
    });

    it("stop() in first TableExpression field value halts before second field (line 94)", () => {
      // Table with two fields: { [k1]=v1, [k2]=v2 } — stop() on v1 → second field's line 94 fires
      const field1 = tstl.createTableFieldExpression(str("v1"), id("k1"));
      const field2 = tstl.createTableFieldExpression(str("v2"), id("k2"));
      const tbl = tstl.createTableExpression([field1, field2]);
      const visited: string[] = [];
      walkStatements([tstl.createExpressionStatement(tbl)], {
        expr: (expr, _replace, control) => {
          if (tstl.isStringLiteral(expr) && expr.value === "v1") {
            visited.push("v1");
            control.stop();
          } else if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
          } else if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
        },
      });
      // k1 (field1.key), then v1 (field1.value, stop); k2/v2 never reached
      expect(visited).toStrictEqual(["k1", "v1"]);
    });

    it("stop() in TableIndexExpression LHS table visit halts before index", () => {
      // arr["key"] = 1 — stop() on "arr" (lhs.table) → "key" (lhs.index) not visited (line 158)
      const lhs = tstl.createTableIndexExpression(id("arr"), str("key"));
      const stmt = tstl.createAssignmentStatement(lhs, num(1));
      const visited: string[] = [];
      walkStatements([stmt], {
        expr: (expr, _replace, control) => {
          if (tstl.isIdentifier(expr) && expr.text === "arr") {
            visited.push("arr");
            control.stop();
          } else if (tstl.isStringLiteral(expr) && expr.value === "key") {
            visited.push("key");
          }
        },
      });
      expect(visited).toStrictEqual(["arr"]);
    });

    it("stop() inside assignment RHS halts before remaining values", () => {
      const stmt = tstl.createAssignmentStatement(id("x"), num(1));
      const stmts: tstl.Statement[] = [stmt, tstl.createExpressionStatement(num(99))];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside variable declaration RHS halts traversal", () => {
      const stmts: tstl.Statement[] = [
        tstl.createVariableDeclarationStatement(id("x"), num(1)),
        tstl.createExpressionStatement(num(99)),
      ];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr, _replace, control) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            control.stop();
          }
        },
      });
      expect(visited).toStrictEqual([1]);
    });
  });

  describe("when walking an elseif chain", () => {
    it("visits all branches of an elseif chain", () => {
      // if (a) then ... elseif (b) then ... else ... end
      const elseBlock = tstl.createBlock([tstl.createExpressionStatement(str("else"))]);
      const elseIf = tstl.createIfStatement(
        id("b"),
        tstl.createBlock([tstl.createExpressionStatement(str("elseif"))]),
        elseBlock,
      );
      const ifStmt = tstl.createIfStatement(
        id("a"),
        tstl.createBlock([tstl.createExpressionStatement(str("if"))]),
        elseIf,
      );
      const stmts: tstl.Statement[] = [ifStmt];

      const strings: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isStringLiteral(expr)) strings.push(expr.value);
        },
      });
      expect(strings).toStrictEqual(["if", "elseif", "else"]);
    });
  });
});

describe("isLuaRhsPure", () => {
  function id(text: string): tstl.Identifier {
    return tstl.createIdentifier(text);
  }

  it("returns true for identifiers", () => {
    expect(isLuaRhsPure(id("a"))).toBe(true);
  });

  it("returns true for nil literal", () => {
    expect(isLuaRhsPure(tstl.createNilLiteral())).toBe(true);
  });

  it.each<{ name: string; isPure: boolean; field: tstl.TableFieldExpression }>([
    {
      name: "pure field",
      isPure: true,
      field: tstl.createTableFieldExpression(id("v"), id("k")),
    },
    {
      name: "non-pure field value",
      isPure: false,
      field: tstl.createTableFieldExpression(tstl.createCallExpression(id("f"), []), id("k")),
    },
    {
      name: "non-pure field key",
      isPure: false,
      field: tstl.createTableFieldExpression(id("v"), tstl.createCallExpression(id("f"), [])),
    },
  ])("returns correct purity for TableExpression $name", ({ isPure, field }) => {
    expect(isLuaRhsPure(tstl.createTableExpression([field]))).toBe(isPure);
  });
});

describe("isLuaExprPure", () => {
  function id(text: string): tstl.Identifier {
    return tstl.createIdentifier(text);
  }

  it("returns false for call and method expressions", () => {
    expect(isLuaExprPure(tstl.createCallExpression(id("f"), []))).toBe(false);
  });

  it.each<{ name: string; expr: tstl.Expression }>([
    { name: "identifier", expr: id("a") },
    { name: "string literal", expr: tstl.createStringLiteral("s") },
    {
      name: "conditional expression",
      expr: tstl.createConditionalExpression(id("c"), id("t"), id("f")),
    },
    {
      name: "parenthesized expression",
      expr: tstl.createParenthesizedExpression(id("a")),
    },
  ])("returns true for $name", ({ expr }) => {
    expect(isLuaExprPure(expr)).toBe(true);
  });

  it.each<{ name: string; expr: tstl.Expression }>([
    {
      name: "binary expression",
      expr: tstl.createBinaryExpression(id("a"), id("b"), tstl.SyntaxKind.AdditionOperator),
    },
    {
      name: "unary expression",
      expr: tstl.createUnaryExpression(id("a"), tstl.SyntaxKind.NegationOperator),
    },
  ])("returns false for $name", ({ expr }) => {
    expect(isLuaExprPure(expr)).toBe(false);
  });
});
