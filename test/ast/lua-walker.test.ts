// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
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
  describe("expression visitor", () => {
    it("visits expressions in variable declarations", () => {
      const stmts: tstl.Statement[] = [
        tstl.createVariableDeclarationStatement(id("x"), num(1)),
        tstl.createVariableDeclarationStatement(id("y"), num(2)),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs.filter(tstl.isNumericLiteral).map((e) => e.value)).toStrictEqual([1, 2]);
    });

    it("visits expressions in assignments (RHS and TableIndexExpression LHS parts)", () => {
      const tableIdx = tstl.createTableIndexExpression(id("arr"), str("key"));
      const stmts: tstl.Statement[] = [tstl.createAssignmentStatement(tableIdx, num(42))];
      const exprs = collectExprs(stmts);
      // LHS TableIndexExpression: table (arr) + index (key), then RHS: 42
      const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
      expect(identifiers).toContain("arr");
      expect(exprs.filter(tstl.isNumericLiteral).map((e) => e.value)).toContain(42);
    });

    it("does NOT visit plain Identifier assignment targets", () => {
      const stmts: tstl.Statement[] = [tstl.createAssignmentStatement(id("x"), num(1))];
      const exprs = collectExprs(stmts);
      const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
      expect(identifiers).not.toContain("x");
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

    it("visits for-init, limit, step, and body", () => {
      const stmts: tstl.Statement[] = [
        tstl.createForStatement(
          tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
          id("i"),
          num(0),
          num(10),
          num(1),
        ),
      ];
      const exprs = collectExprs(stmts);
      const nums = exprs.filter(tstl.isNumericLiteral).map((e) => e.value);
      expect(nums).toContain(0);
      expect(nums).toContain(10);
      expect(nums).toContain(1);
      const strs = exprs.filter(tstl.isStringLiteral).map((e) => e.value);
      expect(strs).toContain("body");
    });

    it("visits for-in expressions and body", () => {
      const stmts: tstl.Statement[] = [
        tstl.createForInStatement(
          tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
          [id("k")],
          [tstl.createCallExpression(id("pairs"), [id("t")])],
        ),
      ];
      const exprs = collectExprs(stmts);
      const identifiers = exprs.filter(tstl.isIdentifier).map((e) => e.text);
      expect(identifiers).toContain("pairs");
      expect(identifiers).toContain("t");
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

    it("visits while condition and body", () => {
      const stmts: tstl.Statement[] = [
        tstl.createWhileStatement(
          tstl.createBlock([tstl.createExpressionStatement(str("body"))]),
          id("cond"),
        ),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs.filter(tstl.isIdentifier).map((e) => e.text)).toContain("cond");
      expect(exprs.filter(tstl.isStringLiteral).map((e) => e.value)).toContain("body");
    });

    it("visits do-statement body", () => {
      const stmts: tstl.Statement[] = [
        tstl.createDoStatement([tstl.createExpressionStatement(num(1))]),
      ];
      const exprs = collectExprs(stmts);
      expect(exprs).toHaveLength(1);
    });
  });

  describe("replace callback", () => {
    it("mutates single expression in variable declaration", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];
      walkStatements(stmts, {
        expr: (expr, replace) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            replace(num(99));
          }
        },
      });
      const decl = stmts[0] as tstl.VariableDeclarationStatement;
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
      const ret = stmts[0] as tstl.ReturnStatement;
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
      const es = stmts[0] as tstl.ExpressionStatement;
      expect(tstl.isIdentifier(es.expression) && es.expression.text).toBe("new");
    });
  });

  describe("skip children", () => {
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

  describe("stmt hook", () => {
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

  describe("shallow mode", () => {
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

  describe("repeat statement", () => {
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

  describe("traversal control", () => {
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

  describe("elseif chain", () => {
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
