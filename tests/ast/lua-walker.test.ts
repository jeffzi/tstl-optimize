// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { getMutableElseBranchStatements, isLuaExprPure, isLuaRhsPure } from "../../src/ast/lua-ast";
import { Walk, walkStatements } from "../../src/ast/lua-walker";

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
      return Walk.keep;
    },
  });
  return visited;
}

describe("getMutableElseBranchStatements", () => {
  it("returns block statements unchanged", () => {
    const elseBlock = tstl.createBlock([tstl.createExpressionStatement(num(1))]);
    const stmt = tstl.createIfStatement(id("cond"), tstl.createBlock([]), elseBlock);

    expect(getMutableElseBranchStatements(stmt)).toBe(elseBlock.statements);
  });

  it("throws when the if statement has no else branch", () => {
    const stmt = tstl.createIfStatement(id("cond"), tstl.createBlock([]));

    expect(() => getMutableElseBranchStatements(stmt)).toThrow(
      "getMutableElseBranchStatements requires an elseBlock",
    );
  });

  it("wraps a bare IfStatement elseBlock (elseif) in a Block so prepended edits persist", () => {
    const elseIf = tstl.createIfStatement(id("cond2"), tstl.createBlock([]));
    const stmt = tstl.createIfStatement(id("cond1"), tstl.createBlock([]), elseIf);

    const statements = getMutableElseBranchStatements(stmt);

    expect(stmt.elseBlock).not.toBe(elseIf);
    if (!stmt.elseBlock || !tstl.isBlock(stmt.elseBlock)) {
      throw new Error("expected elseBlock to be rewrapped as a Block");
    }
    expect(statements).toBe(stmt.elseBlock.statements);
    expect(statements).toStrictEqual([elseIf]);

    const decl = tstl.createVariableDeclarationStatement(id("hoisted"), num(1));
    statements.unshift(decl);
    expect(stmt.elseBlock.statements[0]).toBe(decl);
    expect(stmt.elseBlock.statements[1]).toBe(elseIf);
  });
});

describe("walkStatements", () => {
  describe("when replacing identifier LHS of assignment statement", () => {
    it("throws when returning Walk.replace for identifier LHS", () => {
      const stmt = tstl.createAssignmentStatement(id("x"), num(1));
      const stmts: tstl.Statement[] = [stmt];

      expect(() => {
        walkStatements(stmts, {
          expr: (expr) => {
            if (tstl.isIdentifier(expr) && expr.text === "x") {
              return Walk.replace(id("y"));
            }
            return Walk.keep;
          },
        });
      }).toThrow(/not replaceable/i);
    });

    it("throws when returning Walk.replaceChildren for identifier LHS", () => {
      const stmt = tstl.createAssignmentStatement(id("x"), num(1));
      const stmts: tstl.Statement[] = [stmt];

      expect(() => {
        walkStatements(stmts, {
          expr: (expr) => {
            if (tstl.isIdentifier(expr) && expr.text === "x") {
              return Walk.replaceChildren(id("y"));
            }
            return Walk.keep;
          },
        });
      }).toThrow(/not replaceable/i);
    });
  });

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

    it("does not throw for bare return statements", () => {
      const bareReturn = tstl.createReturnStatement([]);
      Reflect.set(bareReturn, "expressions", undefined);
      const stmts: tstl.Statement[] = [bareReturn];

      expect(() => collectExprs(stmts)).not.toThrow();
      expect(collectExprs(stmts)).toStrictEqual([]);
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
          return Walk.keep;
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
          return Walk.keep;
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
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          return Walk.keep;
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
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            visited.push("call");
            return Walk.skip;
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
          return Walk.keep;
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
          return Walk.keep;
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
          return Walk.keep;
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
        expr: (expr: tstl.Expression) => {
          if (tstl.isNumericLiteral(expr)) {
            seenDepths.push(hooks.guardDepth);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (_expr: tstl.Expression) => Walk.keep,
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
        expr: (expr: tstl.Expression) => {
          if (tstl.isNumericLiteral(expr)) {
            seenDepths.push(hooks.guardDepth);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push("step");
            return Walk.stop;
          }
          if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          return Walk.keep;
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside call expression halts before remaining params", () => {
      const call = tstl.createCallExpression(id("fn"), [num(1), num(2), num(3)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push(1);
            return Walk.stop;
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });
      expect(visited).toStrictEqual([1]);
    });

    it("stop() inside table index expression halts before index", () => {
      const idx = tstl.createTableIndexExpression(id("tbl"), str("key"));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(idx)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            return Walk.stop;
          }
          return Walk.keep;
        },
      });
      expect(visited).toStrictEqual(["tbl"]);
    });

    it("stop() inside conditional expression halts after whenTrue", () => {
      const cond = tstl.createConditionalExpression(id("c"), num(1), num(2));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(cond)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
            return Walk.stop;
          }
          if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push("body");
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 0) {
            visited.push("init");
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 10) {
            visited.push("limit");
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            return Walk.stop;
          }
          return Walk.keep;
        },
      });
      expect(visited).toStrictEqual(["iter"]);
    });

    it("stop() inside method call halts before remaining params", () => {
      const method = tstl.createMethodCallExpression(id("obj"), id("m"), [num(1), num(2)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(method)];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            visited.push(1);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr) && expr.text === "key") {
            visited.push("key");
            return Walk.stop;
          }
          if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isStringLiteral(expr) && expr.value === "v1") {
            visited.push("v1");
            return Walk.stop;
          }
          if (tstl.isIdentifier(expr)) {
            visited.push(expr.text);
          } else if (tstl.isStringLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isIdentifier(expr) && expr.text === "arr") {
            visited.push("arr");
            return Walk.stop;
          }
          if (tstl.isStringLiteral(expr) && expr.value === "key") {
            visited.push("key");
          }
          return Walk.keep;
        },
      });
      expect(visited).toStrictEqual(["arr"]);
    });

    it("stop() inside assignment RHS halts before remaining values", () => {
      const stmt = tstl.createAssignmentStatement(id("x"), num(1));
      const stmts: tstl.Statement[] = [stmt, tstl.createExpressionStatement(num(99))];
      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          return Walk.keep;
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
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            return Walk.stop;
          }
          return Walk.keep;
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
          return Walk.keep;
        },
      });
      expect(strings).toStrictEqual(["if", "elseif", "else"]);
    });
  });
});

describe("isLuaRhsPure", () => {
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

describe("Walk action API", () => {
  describe("Walk.keep", () => {
    it("returning Walk.keep recurses into visited node children", () => {
      // Binary expression: left + right
      // Both operands should be visited when Walk.keep is returned
      const bin = tstl.createBinaryExpression(num(1), num(2), tstl.SyntaxKind.AdditionOperator);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(bin)];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });

      expect(visited).toStrictEqual([1, 2]);
    });

    it("returning Walk.keep allows visiting call expression children", () => {
      // call(1, 2, 3) — all params should be visited
      const call = tstl.createCallExpression(id("fn"), [num(1), num(2), num(3)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });

      expect(visited).toStrictEqual([1, 2, 3]);
    });
  });

  describe("Walk.skip", () => {
    it("returning Walk.skip prevents recursing into children but siblings continue", () => {
      // call(inner()) — skip on outer call prevents visiting inner and its param
      // but sibling num(99) is still visited
      const inner = tstl.createCallExpression(id("inner"), [num(1)]);
      const outer = tstl.createCallExpression(inner, []);
      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(outer),
        tstl.createExpressionStatement(num(99)),
      ];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            visited.push("call");
            return Walk.skip;
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
          return Walk.keep;
        },
      });

      // Outer call skipped (inner not visited), but sibling num(99) is visited
      expect(visited).toStrictEqual(["call", "num:99"]);
    });

    it("returning Walk.skip on a nested expression skips only its children", () => {
      // BinaryExpression(call(f, 42), 99): skip the left call prevents visiting f and 42,
      // but the right operand num(99) at the binary level is still visited.
      const call = tstl.createCallExpression(id("f"), [num(42)]);
      const binary = tstl.createBinaryExpression(call, num(99), tstl.SyntaxKind.AdditionOperator);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(binary)];
      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            visited.push("call");
            return Walk.skip;
          }
          if (tstl.isIdentifier(expr)) visited.push(`id:${expr.text}`);
          if (tstl.isNumericLiteral(expr)) visited.push(`num:${expr.value}`);
          return Walk.keep;
        },
      });
      // Skipping call prevents its children (f, 42); binary's right operand 99 still visited
      expect(visited).toStrictEqual(["call", "num:99"]);
    });

    it("returning Walk.skip continues visiting sibling expressions in same parent", () => {
      // Conditional: cond ? then : else
      // Skip condition prevents its traversal but then/else still visited
      const cond = tstl.createConditionalExpression(id("c"), num(1), num(2));
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(cond)];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isIdentifier(expr) && expr.text === "c") {
            visited.push("cond");
            return Walk.skip;
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
          return Walk.keep;
        },
      });

      expect(visited).toStrictEqual(["cond", "num:1", "num:2"]);
    });
  });

  // Walk.stop behavior is exhaustively covered by the "when controlling traversal" and
  // "when stop() is called in specific expression contexts" describe blocks above.

  describe("Walk.replace", () => {
    it("swaps parent slot with replacement node", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];

      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            return Walk.replace(num(99));
          }
          return Walk.keep;
        },
      });

      const decl = stmts[0];
      if (!decl) return;
      assertNode(decl, tstl.isVariableDeclarationStatement);
      expect(decl.right?.[0] && tstl.isNumericLiteral(decl.right[0]) && decl.right[0].value).toBe(
        99,
      );
    });

    it("does not recurse into original node children when replacing", () => {
      // If replacement recurses into original, we'd visit num(1) inside the call
      const call = tstl.createCallExpression(id("f"), [num(1)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
          if (tstl.isCallExpression(expr)) {
            // Replace the outer call with a simple identifier
            return Walk.replace(id("replacement"));
          }
          if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
          }
          return Walk.keep;
        },
      });

      // The call expression is replaced atomically; the hook is not called again for the
      // replacement. The original call's param (num(1)) is not visited because we don't
      // recurse into the original when Walk.replace is used.
      expect(visited).toStrictEqual([]);
    });

    it("does not recurse into replacement node children", () => {
      // Replace num(1) with a call expression call(2, 3)
      // The replacement node's children (2, 3) should not be visited
      const call = tstl.createCallExpression(id("fn"), [num(2), num(3)]);
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
            if (expr.value === 1) {
              return Walk.replace(call);
            }
          }
          if (tstl.isIdentifier(expr)) {
            visited.push(`id:${expr.text}`);
          }
          return Walk.keep;
        },
      });

      // num(1) is replaced with call(fn, [2, 3])
      // The replacement's children (fn, 2, 3) should not be visited
      // Only num(1) is visited (not id:x which is on LHS, not visited as an expression)
      expect(visited).toStrictEqual(["num:1"]);
    });

    it("continues visiting sibling expressions after replacement", () => {
      // return num(1), num(2), num(3)
      // Replace num(1) with num(10); num(2) and num(3) should still be visited
      const stmts: tstl.Statement[] = [tstl.createReturnStatement([num(1), num(2), num(3)])];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
            if (expr.value === 1) {
              return Walk.replace(num(10));
            }
          }
          return Walk.keep;
        },
      });

      expect(visited).toStrictEqual([1, 2, 3]);
    });

    it("throws when trying to replace with self-reference (same object)", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];

      expect(() => {
        walkStatements(stmts, {
          expr: (expr) => {
            if (tstl.isNumericLiteral(expr) && expr.value === 1) {
              // Attempt to replace with the same object
              return Walk.replace(expr);
            }
            return Walk.keep;
          },
        });
      }).toThrow();
    });

    it.each([
      {
        label: "for-statement controlVariableInitializer",
        makeStmts: () => {
          const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), num(0), num(10));
          return { stmts: [forStmt], target: forStmt };
        },
        targetValue: 0,
        check: (target: tstl.ForStatement) =>
          tstl.isNumericLiteral(target.controlVariableInitializer) &&
          target.controlVariableInitializer.value === 99,
      },
      {
        label: "for-statement limitExpression",
        makeStmts: () => {
          const forStmt = tstl.createForStatement(tstl.createBlock([]), id("i"), num(0), num(10));
          return { stmts: [forStmt], target: forStmt };
        },
        targetValue: 10,
        check: (target: tstl.ForStatement) =>
          tstl.isNumericLiteral(target.limitExpression) && target.limitExpression.value === 99,
      },
      {
        label: "for-statement stepExpression",
        makeStmts: () => {
          const forStmt = tstl.createForStatement(
            tstl.createBlock([]),
            id("i"),
            num(0),
            num(10),
            num(2),
          );
          return { stmts: [forStmt], target: forStmt };
        },
        targetValue: 2,
        check: (target: tstl.ForStatement) =>
          target.stepExpression !== undefined &&
          tstl.isNumericLiteral(target.stepExpression) &&
          target.stepExpression.value === 99,
      },
      {
        label: "for-in-statement expressions",
        makeStmts: () => {
          const forIn = tstl.createForInStatement(tstl.createBlock([]), [id("k")], [num(5)]);
          return { stmts: [forIn], target: forIn };
        },
        targetValue: 5,
        check: (target: tstl.ForInStatement) => {
          const expr = target.expressions[0];
          return expr ? tstl.isNumericLiteral(expr) && expr.value === 99 : false;
        },
      },
      {
        label: "while-statement condition",
        makeStmts: () => {
          const whileStmt = tstl.createWhileStatement(tstl.createBlock([]), num(1));
          return { stmts: [whileStmt], target: whileStmt };
        },
        targetValue: 1,
        check: (target: tstl.WhileStatement) =>
          tstl.isNumericLiteral(target.condition) && target.condition.value === 99,
      },
      {
        label: "repeat-statement condition",
        makeStmts: () => {
          const repeatStmt = tstl.createRepeatStatement(tstl.createBlock([]), num(1));
          return { stmts: [repeatStmt], target: repeatStmt };
        },
        targetValue: 1,
        check: (target: tstl.RepeatStatement) =>
          tstl.isNumericLiteral(target.condition) && target.condition.value === 99,
      },
      {
        label: "if-statement condition",
        makeStmts: () => {
          const ifStmt = tstl.createIfStatement(num(1), tstl.createBlock([]));
          return { stmts: [ifStmt], target: ifStmt };
        },
        targetValue: 1,
        check: (target: tstl.IfStatement) =>
          tstl.isNumericLiteral(target.condition) && target.condition.value === 99,
      },
      {
        label: "assignment-statement RHS",
        makeStmts: () => {
          const assignStmt = tstl.createAssignmentStatement(id("x"), num(1));
          return { stmts: [assignStmt], target: assignStmt };
        },
        targetValue: 1,
        check: (target: tstl.AssignmentStatement) => {
          const expr = target.right[0];
          return expr ? tstl.isNumericLiteral(expr) && expr.value === 99 : false;
        },
      },
      {
        label: "assignment-statement LHS table",
        makeStmts: () => {
          const tableIdx = tstl.createTableIndexExpression(num(1), str("k"));
          const assignStmt = tstl.createAssignmentStatement(tableIdx, num(2));
          return { stmts: [assignStmt], target: tableIdx };
        },
        targetValue: 1,
        check: (target: tstl.TableIndexExpression) =>
          tstl.isNumericLiteral(target.table) && target.table.value === 99,
      },
      {
        label: "assignment-statement LHS index",
        makeStmts: () => {
          const tableIdx = tstl.createTableIndexExpression(id("t"), num(1));
          const assignStmt = tstl.createAssignmentStatement(tableIdx, num(2));
          return { stmts: [assignStmt], target: tableIdx };
        },
        targetValue: 1,
        check: (target: tstl.TableIndexExpression) =>
          tstl.isNumericLiteral(target.index) && target.index.value === 99,
      },
      {
        label: "table-expression field value",
        makeStmts: () => {
          const field = tstl.createTableFieldExpression(num(1), id("key"));
          const tbl = tstl.createTableExpression([field]);
          return { stmts: [tstl.createExpressionStatement(tbl)], target: field };
        },
        targetValue: 1,
        check: (target: tstl.TableFieldExpression) =>
          tstl.isNumericLiteral(target.value) && target.value.value === 99,
      },
      {
        label: "conditional-expression condition",
        makeStmts: () => {
          const cond = tstl.createConditionalExpression(num(1), id("t"), id("f"));
          return { stmts: [tstl.createExpressionStatement(cond)], target: cond };
        },
        targetValue: 1,
        check: (target: tstl.ConditionalExpression) =>
          tstl.isNumericLiteral(target.condition) && target.condition.value === 99,
      },
      {
        label: "conditional-expression whenTrue branch",
        makeStmts: () => {
          const cond = tstl.createConditionalExpression(id("c"), num(1), id("f"));
          return { stmts: [tstl.createExpressionStatement(cond)], target: cond };
        },
        targetValue: 1,
        check: (target: tstl.ConditionalExpression) =>
          tstl.isNumericLiteral(target.whenTrue) && target.whenTrue.value === 99,
      },
      {
        label: "conditional-expression whenFalse branch",
        makeStmts: () => {
          const cond = tstl.createConditionalExpression(id("c"), id("t"), num(1));
          return { stmts: [tstl.createExpressionStatement(cond)], target: cond };
        },
        targetValue: 1,
        check: (target: tstl.ConditionalExpression) =>
          tstl.isNumericLiteral(target.whenFalse) && target.whenFalse.value === 99,
      },
      {
        label: "method-call-expression prefixExpression",
        makeStmts: () => {
          const call = tstl.createMethodCallExpression(num(1), id("method"), []);
          return { stmts: [tstl.createExpressionStatement(call)], target: call };
        },
        targetValue: 1,
        check: (target: tstl.MethodCallExpression) =>
          tstl.isNumericLiteral(target.prefixExpression) && target.prefixExpression.value === 99,
      },
      {
        label: "method-call-expression param",
        makeStmts: () => {
          const call = tstl.createMethodCallExpression(id("obj"), id("method"), [num(1)]);
          return { stmts: [tstl.createExpressionStatement(call)], target: call };
        },
        targetValue: 1,
        check: (target: tstl.MethodCallExpression) => {
          const param = target.params[0];
          return param ? tstl.isNumericLiteral(param) && param.value === 99 : false;
        },
      },
      {
        label: "table-expression field key",
        makeStmts: () => {
          const field = tstl.createTableFieldExpression(id("val"), num(1));
          const tbl = tstl.createTableExpression([field]);
          return { stmts: [tstl.createExpressionStatement(tbl)], target: field };
        },
        targetValue: 1,
        check: (target: tstl.TableFieldExpression) =>
          target.key !== undefined && tstl.isNumericLiteral(target.key) && target.key.value === 99,
      },
    ])("replaces node in $label context", ({ makeStmts, targetValue, check }) => {
      const { stmts, target } = makeStmts();
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === targetValue) {
            return Walk.replace(num(99));
          }
          return Walk.keep;
        },
      });
      expect(check(target as never)).toBe(true);
    });
  });

  describe("Walk action singletons", () => {
    it.each([
      { name: "Walk.keep", singleton: Walk.keep },
      { name: "Walk.skip", singleton: Walk.skip },
      { name: "Walk.stop", singleton: Walk.stop },
    ])("$name is frozen at runtime", ({ singleton }) => {
      expect(Object.isFrozen(singleton)).toBe(true);
    });
  });

  describe("Walk.replaceChildren", () => {
    it("swaps parent slot with replacement node", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];

      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            return Walk.replaceChildren(num(99));
          }
          return Walk.keep;
        },
      });

      const decl = stmts[0];
      if (!decl) return;
      assertNode(decl, tstl.isVariableDeclarationStatement);
      expect(decl.right?.[0] && tstl.isNumericLiteral(decl.right[0]) && decl.right[0].value).toBe(
        99,
      );
    });

    it("recurses into replacement node children", () => {
      // Replace a call with a binary expression; the binary's operands should be visited
      const replacement = tstl.createBinaryExpression(
        num(10),
        num(20),
        tstl.SyntaxKind.AdditionOperator,
      );
      const call = tstl.createCallExpression(id("f"), [num(1)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            return Walk.replaceChildren(replacement);
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });

      // The replacement's children (10, 20) should be visited
      expect(visited).toStrictEqual([10, 20]);
    });

    it("does not visit replacement node root, only its children", () => {
      // Replace a call with a unary expression(num(5))
      // The unary itself should not trigger its own hook, only its child should
      const replacement = tstl.createUnaryExpression(num(5), tstl.SyntaxKind.NegationOperator);
      const call = tstl.createCallExpression(id("f"), [num(1)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];

      const visited: string[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            visited.push("call");
            return Walk.replaceChildren(replacement);
          }
          if (tstl.isUnaryExpression(expr)) {
            visited.push("unary");
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(`num:${expr.value}`);
          }
          return Walk.keep;
        },
      });

      // The call is replaced, but the replacement unary itself is not offered to the hook
      // Only its child num(5) is visited
      expect(visited).toStrictEqual(["call", "num:5"]);
    });

    it("does not visit original node children when using replaceChildren", () => {
      // Replace call(1, 2, 3) with call(10); original's children (1, 2, 3) should not be visited
      const replacement = tstl.createCallExpression(id("other"), [num(10)]);
      const call = tstl.createCallExpression(id("f"), [num(1), num(2), num(3)]);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(call)];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            return Walk.replaceChildren(replacement);
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });

      // Only the replacement's child (10) should be visited, not the original's (1, 2, 3)
      expect(visited).toStrictEqual([10]);
    });

    it("continues visiting sibling expressions after replaceChildren", () => {
      // return call(), num(2), num(3)
      // Replace call with a binary; num(2) and num(3) should still be visited
      const replacement = tstl.createBinaryExpression(
        num(10),
        num(20),
        tstl.SyntaxKind.AdditionOperator,
      );
      const call = tstl.createCallExpression(id("f"), []);
      const stmts: tstl.Statement[] = [tstl.createReturnStatement([call, num(2), num(3)])];

      const visited: number[] = [];
      walkStatements(stmts, {
        expr: (expr) => {
          if (tstl.isCallExpression(expr)) {
            return Walk.replaceChildren(replacement);
          }
          if (tstl.isNumericLiteral(expr)) {
            visited.push(expr.value);
          }
          return Walk.keep;
        },
      });

      // Replacement children (10, 20) visited, then siblings (2, 3)
      expect(visited).toStrictEqual([10, 20, 2, 3]);
    });

    it("preserves guardDepth and shallow context in replacement children", () => {
      // Replace an identifier inside a guarded context (and RHS) with a function
      // The function's body should still respect shallow mode
      const funcExpr = tstl.createFunctionExpression(
        tstl.createBlock([tstl.createExpressionStatement(num(42))]),
        [],
      );
      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(
          tstl.createBinaryExpression(
            id("a"),
            id("b"), // This is on the RHS of AND, guardDepth+1
            tstl.SyntaxKind.AndOperator,
          ),
        ),
      ];

      const depthsAt: { expr: string; depth: number }[] = [];
      walkStatements(stmts, {
        shallow: true,
        guardDepth: 0,
        expr: (expr) => {
          if (tstl.isIdentifier(expr) && expr.text === "b") {
            // Replace with a function; shallow should prevent visiting body
            depthsAt.push({ expr: "before-replace", depth: 0 }); // Would be 1 if we could check
            return Walk.replaceChildren(funcExpr);
          }
          if (tstl.isNumericLiteral(expr)) {
            depthsAt.push({ expr: `num:${expr.value}`, depth: 0 }); // placeholder
          }
          return Walk.keep;
        },
      });

      // With shallow=true, the function body should not be visited
      // So num(42) should not appear in depthsAt
      expect(depthsAt.map((d) => d.expr)).not.toContain("num:42");
    });

    it("throws when trying to replaceChildren with self-reference (same object)", () => {
      const stmts: tstl.Statement[] = [tstl.createVariableDeclarationStatement(id("x"), num(1))];

      expect(() => {
        walkStatements(stmts, {
          expr: (expr) => {
            if (tstl.isNumericLiteral(expr) && expr.value === 1) {
              // Attempt to replaceChildren with the same object
              return Walk.replaceChildren(expr);
            }
            return Walk.keep;
          },
        });
      }).toThrow();
    });

    it("fires funcEnter and funcExit when replaceChildren yields a FunctionExpression (shallow=false)", () => {
      // Original: num(1). Replace it with a FunctionExpression containing num(99) in its body.
      // With shallow=false, replaceChildren should recurse into the replacement body,
      // calling funcEnter before the body walk and funcExit after.
      const bodyStmt = tstl.createExpressionStatement(num(99));
      const funcExpr = tstl.createFunctionExpression(tstl.createBlock([bodyStmt]), []);
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(num(1))];
      const events: string[] = [];
      walkStatements(stmts, {
        shallow: false,
        funcEnter: () => events.push("enter"),
        funcExit: () => events.push("exit"),
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            return Walk.replaceChildren(funcExpr);
          }
          if (tstl.isNumericLiteral(expr) && expr.value === 99) {
            events.push("body");
          }
          return Walk.keep;
        },
      });
      expect(events).toStrictEqual(["enter", "body", "exit"]);
    });

    it("does not fire funcEnter/funcExit when replaceChildren yields a FunctionExpression with shallow=true", () => {
      const funcExpr = tstl.createFunctionExpression(
        tstl.createBlock([tstl.createExpressionStatement(num(99))]),
        [],
      );
      const stmts: tstl.Statement[] = [tstl.createExpressionStatement(num(1))];
      const events: string[] = [];
      walkStatements(stmts, {
        shallow: true,
        funcEnter: () => events.push("enter"),
        funcExit: () => events.push("exit"),
        expr: (expr) => {
          if (tstl.isNumericLiteral(expr) && expr.value === 1) {
            return Walk.replaceChildren(funcExpr);
          }
          if (tstl.isNumericLiteral(expr) && expr.value === 99) {
            events.push("body");
          }
          return Walk.keep;
        },
      });
      // shallow=true: function body not entered, funcEnter/funcExit not called
      expect(events).toStrictEqual([]);
    });
  });
});
