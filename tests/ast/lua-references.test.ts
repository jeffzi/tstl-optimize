// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import {
  type AccessEntry,
  forEachAccess,
  withoutShadowedNames,
} from "../../src/ast/lua-references";

function id(name: string): tstl.Identifier {
  return tstl.createIdentifier(name);
}

function num(value: number): tstl.NumericLiteral {
  return tstl.createNumericLiteral(value);
}

function collect(stmt: tstl.Statement): AccessEntry[] {
  const entries: AccessEntry[] = [];
  forEachAccess(stmt, (e) => {
    entries.push(e);
    return undefined;
  });
  return entries;
}

describe("forEachAccess", () => {
  describe("AssignmentStatement with Identifier LHS evaluation order", () => {
    it("emits table read, index read, then deferred write (x = t[x] + 1)", () => {
      // x = t[x] + 1
      // LHS: plain Identifier x  (deferred write)
      // RHS: BinaryExpression(TableIndexExpression(t, x), 1)
      const t = id("t");
      const x = id("x");
      const rhs = tstl.createBinaryExpression(
        tstl.createTableIndexExpression(t, x),
        num(1),
        tstl.SyntaxKind.AdditionOperator,
      );
      const stmt = tstl.createAssignmentStatement([id("x")], [rhs]);

      const entries = collect(stmt);

      expect(entries).toHaveLength(3);
      expect(entries[0]).toStrictEqual({
        identifier: expect.objectContaining({ text: "t" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries[1]).toStrictEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries[2]).toStrictEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "write",
        inFunctionBody: false,
      });
    });
  });

  describe("AssignmentStatement with TableIndexExpression LHS", () => {
    it("emits table and index reads, no write marker (t[x] = 1)", () => {
      const stmt = tstl.createAssignmentStatement(
        [tstl.createTableIndexExpression(id("t"), id("x"))],
        [num(1)],
      );

      const entries = collect(stmt);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toStrictEqual({
        identifier: expect.objectContaining({ text: "t" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries[1]).toStrictEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "read",
        inFunctionBody: false,
      });
    });
  });

  describe("AssignmentStatement with multiple Identifier LHS", () => {
    it("emits writes in source order (x, y = 1, 2)", () => {
      const stmt = tstl.createAssignmentStatement([id("x"), id("y")], [num(1), num(2)]);

      const entries = collect(stmt);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toStrictEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "write",
        inFunctionBody: false,
      });
      expect(entries[1]).toStrictEqual({
        identifier: expect.objectContaining({ text: "y" }),
        kind: "write",
        inFunctionBody: false,
      });
    });
  });

  describe("AssignmentStatement with mixed LHS", () => {
    it("emits table/index reads first, then deferred writes (x, t[y] = 1, 2)", () => {
      const stmt = tstl.createAssignmentStatement(
        [id("x"), tstl.createTableIndexExpression(id("t"), id("y"))],
        [num(1), num(2)],
      );

      const entries = collect(stmt);

      expect(entries).toHaveLength(3);
      expect(entries[0]).toStrictEqual({
        identifier: expect.objectContaining({ text: "t" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries[1]).toStrictEqual({
        identifier: expect.objectContaining({ text: "y" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries[2]).toStrictEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "write",
        inFunctionBody: false,
      });
    });
  });

  describe("inFunctionBody flag for nested closure accesses", () => {
    it("sets inFunctionBody: true for accesses inside FunctionExpression body", () => {
      const innerAssign = tstl.createAssignmentStatement([id("x")], [num(2)]);
      const fn = tstl.createFunctionExpression(tstl.createBlock([innerAssign]), []);
      const stmt = tstl.createVariableDeclarationStatement([id("fn")], [fn]);

      const entries = collect(stmt);

      expect(entries).toContainEqual({
        identifier: expect.objectContaining({ text: "x" }),
        kind: "write",
        inFunctionBody: true,
      });
    });
  });

  describe("Early exit when visitor returns true", () => {
    it("stops walking after first match", () => {
      const stmt = tstl.createAssignmentStatement([id("x"), id("y")], [num(1), num(2)]);

      let count = 0;
      forEachAccess(stmt, () => {
        count++;
        return true; // stop early
      });

      expect(count).toBe(1);
    });
  });

  describe("Closure with no outer-symbol access", () => {
    it("emits inFunctionBody: true writes inside nested closures", () => {
      const innerDecl = tstl.createVariableDeclarationStatement([id("y")], [num(1)]);
      const fn = tstl.createFunctionExpression(tstl.createBlock([innerDecl]), []);
      const stmt = tstl.createVariableDeclarationStatement([id("fn")], [fn]);

      const entries = collect(stmt);

      expect(entries).toContainEqual({
        identifier: expect.objectContaining({ text: "y" }),
        kind: "write",
        inFunctionBody: true,
      });
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          identifier: expect.objectContaining({ text: "x" }),
        }),
      );
    });
  });

  describe("ConditionalExpression", () => {
    it("walks condition, whenTrue, whenFalse in order as reads (a ? b : c)", () => {
      const expr = tstl.createConditionalExpression(id("a"), id("b"), id("c"));
      const stmt = tstl.createExpressionStatement(expr);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "c" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it.each([
      {
        name: "condition (a)",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createConditionalExpression(id("a"), id("b"), id("c")),
          ),
        stopAt: "a",
      },
      {
        name: "whenTrue (b)",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createConditionalExpression(id("a"), id("b"), id("c")),
          ),
        stopAt: "b",
      },
      {
        name: "whenFalse (c)",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createConditionalExpression(id("a"), id("b"), id("c")),
          ),
        stopAt: "c",
      },
    ])("stops early at $name", ({ build, stopAt }) => {
      const visited: string[] = [];
      forEachAccess(build(), (e) => {
        visited.push(e.identifier.text);
        return e.identifier.text === stopAt;
      });
      expect(visited[visited.length - 1]).toBe(stopAt);
    });

    it("sets inFunctionBody: true for accesses inside a FunctionExpression body", () => {
      const fn = tstl.createFunctionExpression(
        tstl.createBlock([
          tstl.createExpressionStatement(
            tstl.createConditionalExpression(id("a"), id("b"), id("c")),
          ),
        ]),
        [],
      );
      const stmt = tstl.createVariableDeclarationStatement([id("fn")], [fn]);

      expect(collect(stmt)).toStrictEqual([
        {
          identifier: expect.objectContaining({ text: "fn" }),
          kind: "write",
          inFunctionBody: false,
        },
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: true },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: true },
        { identifier: expect.objectContaining({ text: "c" }), kind: "read", inFunctionBody: true },
      ]);
    });
  });

  describe("Expression walker branches", () => {
    it("walks UnaryExpression operand (-x)", () => {
      const expr = tstl.createUnaryExpression(id("x"), tstl.SyntaxKind.NegationOperator);
      const stmt = tstl.createExpressionStatement(expr);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "x" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks CallExpression callee and params (f(a, b))", () => {
      const call = tstl.createCallExpression(id("f"), [id("a"), id("b")]);
      const stmt = tstl.createExpressionStatement(call);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "f" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks MethodCallExpression prefix and params (obj:m(a))", () => {
      const call = tstl.createMethodCallExpression(id("obj"), id("m"), [id("a")]);
      const stmt = tstl.createExpressionStatement(call);

      const entries = collect(stmt);
      expect(entries).toContainEqual({
        identifier: expect.objectContaining({ text: "obj" }),
        kind: "read",
        inFunctionBody: false,
      });
      expect(entries).toContainEqual({
        identifier: expect.objectContaining({ text: "a" }),
        kind: "read",
        inFunctionBody: false,
      });
    });

    it("walks TableExpression field keys and values ({[k]=v, x})", () => {
      const keyedField = tstl.createTableFieldExpression(id("v"), id("k"));
      const positionalField = tstl.createTableFieldExpression(id("x"));
      const tableExpr = tstl.createTableExpression([keyedField, positionalField]);
      const stmt = tstl.createExpressionStatement(tableExpr);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "k" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "v" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "x" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks ParenthesizedExpression inner ((x))", () => {
      const expr = tstl.createParenthesizedExpression(id("x"));
      const stmt = tstl.createExpressionStatement(expr);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "x" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("returns no entries for non-identifier literal expression", () => {
      const stmt = tstl.createExpressionStatement(num(42));
      expect(collect(stmt)).toStrictEqual([]);
    });
  });

  describe("Statement dispatch branches", () => {
    it("walks ReturnStatement expressions (return x, y)", () => {
      const stmt = tstl.createReturnStatement([id("x"), id("y")]);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "x" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "y" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("handles ReturnStatement with no expressions", () => {
      const stmt = tstl.createReturnStatement([]);
      expect(collect(stmt)).toStrictEqual([]);
    });

    it("handles VariableDeclarationStatement with no RHS (local x)", () => {
      const stmt = tstl.createVariableDeclarationStatement([id("x")]);
      expect(collect(stmt)).toStrictEqual([
        {
          identifier: expect.objectContaining({ text: "x" }),
          kind: "write",
          inFunctionBody: false,
        },
      ]);
    });

    it("walks IfStatement condition, ifBlock, and Block elseBlock", () => {
      const ifBody = tstl.createBlock([tstl.createExpressionStatement(id("b"))]);
      const elseBody = tstl.createBlock([tstl.createExpressionStatement(id("c"))]);
      const stmt = tstl.createIfStatement(id("a"), ifBody, elseBody);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "c" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks IfStatement without elseBlock", () => {
      const ifBody = tstl.createBlock([tstl.createExpressionStatement(id("b"))]);
      const stmt = tstl.createIfStatement(id("a"), ifBody);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks IfStatement else-if chain recursively", () => {
      const innerIf = tstl.createIfStatement(
        id("b"),
        tstl.createBlock([tstl.createExpressionStatement(id("c"))]),
      );
      const outer = tstl.createIfStatement(id("a"), tstl.createBlock([]), innerIf);

      expect(collect(outer)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "c" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks WhileStatement condition then body", () => {
      const body = tstl.createBlock([tstl.createExpressionStatement(id("b"))]);
      const stmt = tstl.createWhileStatement(body, id("a"));

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks RepeatStatement body before condition", () => {
      const body = tstl.createBlock([tstl.createExpressionStatement(id("b"))]);
      const stmt = tstl.createRepeatStatement(body, id("a"));

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks ForStatement init, limit, step, then body", () => {
      const body = tstl.createBlock([tstl.createExpressionStatement(id("body"))]);
      const stmt = tstl.createForStatement(body, id("i"), id("start"), id("stop"), id("step"));

      expect(collect(stmt)).toStrictEqual([
        {
          identifier: expect.objectContaining({ text: "start" }),
          kind: "read",
          inFunctionBody: false,
        },
        {
          identifier: expect.objectContaining({ text: "stop" }),
          kind: "read",
          inFunctionBody: false,
        },
        {
          identifier: expect.objectContaining({ text: "step" }),
          kind: "read",
          inFunctionBody: false,
        },
        {
          identifier: expect.objectContaining({ text: "body" }),
          kind: "read",
          inFunctionBody: false,
        },
      ]);
    });

    it("walks ForStatement without step", () => {
      const body = tstl.createBlock([tstl.createExpressionStatement(id("body"))]);
      const stmt = tstl.createForStatement(body, id("i"), id("start"), id("stop"));

      expect(collect(stmt)).toStrictEqual([
        {
          identifier: expect.objectContaining({ text: "start" }),
          kind: "read",
          inFunctionBody: false,
        },
        {
          identifier: expect.objectContaining({ text: "stop" }),
          kind: "read",
          inFunctionBody: false,
        },
        {
          identifier: expect.objectContaining({ text: "body" }),
          kind: "read",
          inFunctionBody: false,
        },
      ]);
    });

    it("walks ForInStatement expressions then body", () => {
      const body = tstl.createBlock([tstl.createExpressionStatement(id("b"))]);
      const stmt = tstl.createForInStatement(body, [id("k"), id("v")], [id("t")]);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "t" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("walks DoStatement body", () => {
      const stmt = tstl.createDoStatement([
        tstl.createExpressionStatement(id("a")),
        tstl.createExpressionStatement(id("b")),
      ]);

      expect(collect(stmt)).toStrictEqual([
        { identifier: expect.objectContaining({ text: "a" }), kind: "read", inFunctionBody: false },
        { identifier: expect.objectContaining({ text: "b" }), kind: "read", inFunctionBody: false },
      ]);
    });

    it("returns no entries for unhandled statement types (BreakStatement)", () => {
      const stmt = tstl.createBreakStatement();
      expect(collect(stmt)).toStrictEqual([]);
    });
  });

  describe("Early exit across nested walkers", () => {
    it.each([
      {
        name: "inside TableIndexExpression LHS table",
        build: () =>
          tstl.createAssignmentStatement(
            [tstl.createTableIndexExpression(id("t"), id("i"))],
            [num(1)],
          ),
        stopAt: "t",
      },
      {
        name: "inside TableIndexExpression LHS index (after table)",
        build: () =>
          tstl.createAssignmentStatement(
            [tstl.createTableIndexExpression(id("t"), id("i"))],
            [num(1)],
          ),
        stopAt: "i",
      },
      {
        name: "inside BinaryExpression left",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createBinaryExpression(id("a"), id("b"), tstl.SyntaxKind.AdditionOperator),
          ),
        stopAt: "a",
      },
      {
        name: "inside UnaryExpression operand",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createUnaryExpression(id("x"), tstl.SyntaxKind.NegationOperator),
          ),
        stopAt: "x",
      },
      {
        name: "inside CallExpression callee",
        build: () => tstl.createExpressionStatement(tstl.createCallExpression(id("f"), [id("a")])),
        stopAt: "f",
      },
      {
        name: "inside CallExpression params",
        build: () => tstl.createExpressionStatement(tstl.createCallExpression(id("f"), [id("a")])),
        stopAt: "a",
      },
      {
        name: "inside MethodCallExpression prefix",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createMethodCallExpression(id("obj"), id("m"), [id("a")]),
          ),
        stopAt: "obj",
      },
      {
        name: "inside MethodCallExpression params",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createMethodCallExpression(id("obj"), id("m"), [id("a")]),
          ),
        stopAt: "a",
      },
      {
        name: "inside TableExpression field key",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createTableExpression([tstl.createTableFieldExpression(id("v"), id("k"))]),
          ),
        stopAt: "k",
      },
      {
        name: "inside TableExpression field value",
        build: () =>
          tstl.createExpressionStatement(
            tstl.createTableExpression([tstl.createTableFieldExpression(id("v"))]),
          ),
        stopAt: "v",
      },
      {
        name: "inside ParenthesizedExpression",
        build: () => tstl.createExpressionStatement(tstl.createParenthesizedExpression(id("x"))),
        stopAt: "x",
      },
    ])("stops at first $name", ({ build, stopAt }) => {
      const stmt = build();
      const visited: string[] = [];
      forEachAccess(stmt, (e) => {
        visited.push(e.identifier.text);
        return e.identifier.text === stopAt;
      });
      expect(visited[visited.length - 1]).toBe(stopAt);
    });

    it.each([
      {
        name: "ReturnStatement",
        build: () => tstl.createReturnStatement([id("a"), id("b")]),
      },
      {
        name: "IfStatement condition",
        build: () =>
          tstl.createIfStatement(
            id("a"),
            tstl.createBlock([tstl.createExpressionStatement(id("b"))]),
          ),
      },
      {
        name: "IfStatement ifBlock (after condition)",
        build: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            tstl.createBlock([
              tstl.createExpressionStatement(id("a")),
              tstl.createExpressionStatement(id("b")),
            ]),
          ),
      },
      {
        name: "IfStatement Block elseBlock",
        build: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            tstl.createBlock([tstl.createExpressionStatement(id("a"))]),
            tstl.createBlock([tstl.createExpressionStatement(id("b"))]),
          ),
      },
      {
        name: "WhileStatement condition",
        build: () =>
          tstl.createWhileStatement(
            tstl.createBlock([tstl.createExpressionStatement(id("b"))]),
            id("a"),
          ),
      },
      {
        name: "WhileStatement body",
        build: () =>
          tstl.createWhileStatement(
            tstl.createBlock([
              tstl.createExpressionStatement(id("a")),
              tstl.createExpressionStatement(id("b")),
            ]),
            tstl.createBooleanLiteral(true),
          ),
      },
      {
        name: "RepeatStatement body",
        build: () =>
          tstl.createRepeatStatement(
            tstl.createBlock([
              tstl.createExpressionStatement(id("a")),
              tstl.createExpressionStatement(id("b")),
            ]),
            tstl.createBooleanLiteral(true),
          ),
      },
      {
        name: "RepeatStatement condition",
        build: () =>
          tstl.createRepeatStatement(
            tstl.createBlock([tstl.createExpressionStatement(id("a"))]),
            id("b"),
          ),
      },
      {
        name: "ForStatement limit",
        build: () => tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b")),
      },
      {
        name: "ForStatement step",
        build: () =>
          tstl.createForStatement(
            tstl.createBlock([]),
            id("i"),
            tstl.createNumericLiteral(0),
            id("a"),
            id("b"),
          ),
      },
      {
        name: "ForStatement body",
        build: () =>
          tstl.createForStatement(
            tstl.createBlock([
              tstl.createExpressionStatement(id("a")),
              tstl.createExpressionStatement(id("b")),
            ]),
            id("i"),
            tstl.createNumericLiteral(0),
            tstl.createNumericLiteral(10),
          ),
      },
      {
        name: "ForInStatement expressions",
        build: () => tstl.createForInStatement(tstl.createBlock([]), [id("k")], [id("a"), id("b")]),
      },
      {
        name: "ForInStatement body",
        build: () =>
          tstl.createForInStatement(
            tstl.createBlock([
              tstl.createExpressionStatement(id("a")),
              tstl.createExpressionStatement(id("b")),
            ]),
            [id("k")],
            [tstl.createIdentifier("t")],
          ),
      },
      {
        name: "DoStatement body",
        build: () =>
          tstl.createDoStatement([
            tstl.createExpressionStatement(id("a")),
            tstl.createExpressionStatement(id("b")),
          ]),
      },
      {
        name: "AssignmentStatement deferred writes",
        build: () => tstl.createAssignmentStatement([id("a"), id("b")], [num(1), num(2)]),
      },
      {
        name: "VariableDeclarationStatement writes",
        build: () => tstl.createVariableDeclarationStatement([id("a"), id("b")], [num(1), num(2)]),
      },
      {
        name: "VariableDeclarationStatement RHS",
        build: () => tstl.createVariableDeclarationStatement([id("x")], [id("a"), id("b")]),
      },
    ])("stops at first access in $name", ({ build }) => {
      let count = 0;
      forEachAccess(build(), () => {
        count++;
        return true;
      });
      expect(count).toBe(1);
    });

    it.each([
      {
        name: "TableIndexExpression on RHS stopping at .table",
        build: () =>
          tstl.createAssignmentStatement(
            [id("x")],
            [tstl.createTableIndexExpression(id("t"), id("i"))],
          ),
        stopAt: "t",
      },
      {
        name: "TableIndexExpression on RHS stopping at .index",
        build: () =>
          tstl.createAssignmentStatement(
            [id("x")],
            [tstl.createTableIndexExpression(id("t"), id("i"))],
          ),
        stopAt: "i",
      },
      {
        name: "AssignmentStatement RHS early exit",
        build: () => tstl.createAssignmentStatement([id("x"), id("y")], [id("a"), id("b")]),
        stopAt: "b",
      },
      {
        name: "VariableDeclarationStatement RHS early exit",
        build: () => tstl.createVariableDeclarationStatement([id("x")], [id("a"), id("b")]),
        stopAt: "b",
      },
      {
        name: "IfStatement else-if recursion early exit",
        build: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            tstl.createBlock([]),
            tstl.createIfStatement(
              id("a"),
              tstl.createBlock([tstl.createExpressionStatement(id("b"))]),
            ),
          ),
        stopAt: "b",
      },
      {
        name: "IfStatement Block elseBlock early exit",
        build: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            tstl.createBlock([tstl.createExpressionStatement(id("a"))]),
            tstl.createBlock([
              tstl.createExpressionStatement(id("b")),
              tstl.createExpressionStatement(id("c")),
            ]),
          ),
        stopAt: "b",
      },
      {
        name: "RepeatStatement condition early exit (after body)",
        build: () =>
          tstl.createRepeatStatement(
            tstl.createBlock([tstl.createExpressionStatement(id("a"))]),
            id("b"),
          ),
        stopAt: "b",
      },
      {
        name: "ForStatement step early exit (literal init/limit)",
        build: () =>
          tstl.createForStatement(
            tstl.createBlock([]),
            id("i"),
            tstl.createNumericLiteral(0),
            tstl.createNumericLiteral(10),
            id("step"),
          ),
        stopAt: "step",
      },
      {
        name: "ForInStatement body early exit (after RHS)",
        build: () =>
          tstl.createForInStatement(
            tstl.createBlock([tstl.createExpressionStatement(id("body"))]),
            [id("k")],
            [tstl.createIdentifier("t")],
          ),
        stopAt: "body",
      },
    ])("stops at named identifier in $name", ({ build, stopAt }) => {
      const visited: string[] = [];
      forEachAccess(build(), (e) => {
        visited.push(e.identifier.text);
        return e.identifier.text === stopAt;
      });
      expect(visited[visited.length - 1]).toBe(stopAt);
    });
  });
});

describe("withoutShadowedNames", () => {
  it.each([
    {
      name: "no shadowing",
      names: new Set(["x", "y"]),
      nodes: ["z"],
      getName: (n: string) => n,
      shouldReturnSameInstance: true,
    },
    {
      name: "single shadow",
      names: new Set(["x", "y"]),
      nodes: ["x"],
      getName: (n: string) => n,
      shouldReturnSameInstance: false,
      expected: new Set(["y"]),
    },
    {
      name: "all shadowed",
      names: new Set(["x"]),
      nodes: ["x"],
      getName: (n: string) => n,
      shouldReturnSameInstance: false,
      expected: new Set(),
    },
    {
      name: "node returns undefined",
      names: new Set(["x"]),
      nodes: [null],
      getName: () => undefined,
      shouldReturnSameInstance: true,
    },
  ])("$name", ({ names, nodes, getName, shouldReturnSameInstance, expected }) => {
    const result = withoutShadowedNames(
      names,
      nodes,
      getName as (n: unknown) => string | undefined,
    );

    if (shouldReturnSameInstance) {
      expect(result).toBe(names);
    } else {
      expect(result).toStrictEqual(expected);
    }
  });
});
