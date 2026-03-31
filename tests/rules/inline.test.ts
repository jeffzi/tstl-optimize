import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { mapLuaStatements } from "../../src/rules/inline";
import { compile, compileMultiFileWithDiagnostics, compileWithDiagnostics } from "../helpers";

describe("inline", () => {
  describe("positive: inlined", () => {
    it("inlines function declaration with single return", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("= double(");
    });

    it("inlines arrow function with expression body", () => {
      const lua = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
    });

    it("inlines function expression with single return", () => {
      const lua = compile(`
        /** @inline */
        const double = function(x: number) { return x * 2; };
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
    });

    it("inlines multiple parameters", () => {
      const lua = compile(`
        /** @inline */
        function add(a: number, b: number) { return a + b; }
        declare const x: number;
        declare const y: number;
        const r = add(x, y);
      `);
      expect(lua).toContain("x + y");
      expect(lua).not.toContain("= add(");
    });

    it("inlines zero parameters", () => {
      const lua = compile(`
        /** @inline */
        function pi() { return 3.14; }
        const r = pi();
      `);
      expect(lua).toContain("3.14");
      expect(lua).not.toContain("= pi(");
    });

    it("inlines when body references module-scope variable", () => {
      const lua = compile(`
        const factor = 10;
        /** @inline */
        function scale(x: number) { return x * factor; }
        declare const a: number;
        const r = scale(a);
      `);
      expect(lua).toContain("a * factor");
      expect(lua).not.toContain("= scale(");
    });

    it("inlines when argument is an expression", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a + 1);
      `);
      expect(lua).toContain("(a + 1) * 2");
      expect(lua).not.toContain("= double(");
    });

    it("wraps compound body in parentheses for operator precedence safety", () => {
      const lua = compile(`
        /** @inline */
        function inc(x: number) { return x + 1; }
        declare const a: number;
        const r = inc(a) * 2;
      `);
      // inc(a) should become (a + 1) * 2, not a + 1 * 2
      expect(lua).toContain("(a + 1) * 2");
      expect(lua).not.toContain("= inc(");
    });

    it("inlines side-effecting arg when param used only once", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare function foo(): number;
        const r = double(foo());
      `);
      expect(lua).toContain("foo() * 2");
      expect(lua).not.toContain("= double(");
    });

    it("inlines function returning object literal", () => {
      const lua = compile(`
        /** @inline */
        function wrap(x: number) { return { value: x }; }
        declare const a: number;
        const r = wrap(a);
      `);
      expect(lua).toContain("value = a");
      expect(lua).not.toContain("= wrap(");
    });

    it("inlines function with property access on parameter", () => {
      const lua = compile(`
        /** @inline */
        function getX(obj: { x: number }) { return obj.x; }
        declare const t: { x: number };
        const r = getX(t);
      `);
      expect(lua).toContain("t.x");
      expect(lua).not.toContain("= getX(");
    });

    it("inlines function with negated parameter", () => {
      const lua = compile(`
        /** @inline */
        function neg(x: number) { return -x; }
        declare const a: number;
        const r = neg(a);
      `);
      expect(lua).toContain("-a");
      expect(lua).not.toContain("= neg(");
    });

    it("inlines function with call expression in body", () => {
      const lua = compile(`
        declare function process(x: number): number;
        /** @inline */
        function wrap(x: number) { return process(x); }
        declare const a: number;
        const r = wrap(a);
      `);
      expect(lua).toContain("process(a)");
      expect(lua).not.toContain("= wrap(");
    });
  });

  describe("comment cleanup", () => {
    it("strips @inline JSDoc comment from function declaration", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).not.toContain("@inline");
    });

    it("strips @inline JSDoc comment from arrow function", () => {
      const lua = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).not.toContain("@inline");
    });
  });

  describe("edge cases", () => {
    it("does not inline when rule is disabled", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `,
        { pluginOptions: { rules: { inline: false } } },
      );
      expect(lua).toContain("double(");
    });

    it("math-intrinsics still works when inline is active", () => {
      const lua = compile(`
        declare const x: number;
        const r = Math.floor(x);
      `);
      expect(lua).toContain("% 1");
      expect(lua).not.toContain("math.floor");
    });

    it("handles arity mismatch gracefully", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        const r = (double as any)();
      `);
      expect(lua).toContain("double(");
    });
  });

  describe("warnings", () => {
    it("warns on multi-statement body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function compute(x: number) {
          const tmp = x * 2;
          return tmp + 1;
        }
        declare const a: number;
        const r = compute(a);
      `);
      expect(lua).toContain("compute(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("single return statement");
    });

    it("warns on single non-return statement body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function sideEffect(x: number) {
          console.log(x);
        }
        declare const a: number;
        sideEffect(a);
      `);
      expect(lua).toContain("sideEffect(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("single return statement");
    });

    it("warns on empty body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function noop() {}
        noop();
      `);
      expect(lua).toContain("noop(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("single return statement");
    });

    it("warns on arity mismatch", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function double(x: number) { return x * 2; }
        // @ts-expect-error testing arity mismatch
        const r = double();
      `);
      expect(lua).toContain("double(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("argument count");
    });

    it("warns on rest parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function first(...args: number[]) { return args[0]; }
        const r = first(1, 2, 3);
      `);
      expect(lua).toContain("first(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("rest parameters");
    });

    it("warns on optional parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function maybe(x?: number) { return x; }
        const r = maybe(5);
      `);
      expect(lua).toContain("maybe(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("optional parameters");
    });

    it("warns on default parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function withDefault(x: number = 0) { return x; }
        const r = withDefault(5);
      `);
      expect(lua).toContain("withDefault(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("default parameters");
    });

    it("warns on non-module scope", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        function outer() {
          const captured = 10;
          /** @inline */
          function inner(x: number) { return x + captured; }
          return inner(5);
        }
      `);
      expect(lua).toContain("inner(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("module scope");
    });

    it("warns on recursive function", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function recurse(x: number): number { return recurse(x); }
        const r = recurse(5);
      `);
      expect(lua).toContain("recurse(");
      // Both the outer call recurse(5) and the inner body call recurse(x) are visited
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].messageText).toContain("recursive");
    });

    it("warns on parameter written inside body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { return (x = 1, x); }
        const result = f(0);
      `);
      expect(lua).toContain("f(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("written inside body");
    });

    it("warns on side-effect duplication", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function square(x: number) { return x * x; }
        declare function foo(): number;
        const r = square(foo());
      `);
      expect(lua).toContain("square(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("side effects");
    });

    it("emits no warning without @inline tag", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("double(");
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("cross-module: inlined (self-contained)", () => {
    it("inlines self-contained function from another module", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          /** @inline */
          export function double(x: number) { return x * 2; }
        `,
        "main.ts": `
          import { double } from "./utils";
          declare const a: number;
          const r = double(a);
        `,
      });
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
      expect(diagnostics).toHaveLength(0);
    });

    it("inlines when body uses const enum (baked as literal by TSTL)", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const enum Dir { Up = 1, Down = 2 }
          /** @inline */
          export function isUp(d: number) { return d === Dir.Up; }
        `,
        "main.ts": `
          import { isUp } from "./utils";
          declare const d: number;
          const r = isUp(d);
        `,
      });
      expect(lua).toContain("d == 1");
      expect(lua).not.toContain("isUp(");
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("cross-module: not inlined (free variables)", () => {
    it("rejects function referencing module constant", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const factor = 10;
          /** @inline */
          export function scale(x: number) { return x * factor; }
        `,
        "main.ts": `
          import { scale } from "./utils";
          declare const a: number;
          const r = scale(a);
        `,
      });
      expect(lua).toContain("scale(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(diagnostics[0].source).toBe("tstl-optimize");
    });

    it("rejects function calling module-scope function", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          function helper(x: number) { return x + 1; }
          /** @inline */
          export function wrap(x: number) { return helper(x); }
        `,
        "main.ts": `
          import { wrap } from "./utils";
          declare const a: number;
          const r = wrap(a);
        `,
      });
      expect(lua).toContain("wrap(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
    });

    it("rejects function referencing non-const enum", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          enum Dir { Up = 1, Down = 2 }
          /** @inline */
          export function isUp(d: number) { return d === Dir.Up; }
        `,
        "main.ts": `
          import { isUp } from "./utils";
          declare const d: number;
          const r = isUp(d);
        `,
      });
      expect(lua).toContain("isUp(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
    });
  });
});

describe("ExpressionStatement preservation", () => {
  it("non-inline expression statement is not erased from Lua output", () => {
    const lua = compile(`
      declare function someFunc(x: number): void;
      declare const a: number;
      someFunc(a);
    `);
    expect(lua).toContain("someFunc(a)");
  });

  it("non-inline expression statement preserved with both inline and debug-strip enabled", () => {
    const lua = compile(
      `
      declare function someFunc(x: number): void;
      declare const a: number;
      someFunc(a);
    `,
      { pluginOptions: { rules: { inline: true, "debug-strip": { functions: ["debug"] } } } },
    );
    expect(lua).toContain("someFunc(a)");
  });
});

describe("mapLuaStatements (unit)", () => {
  /** leafFn that replaces any Identifier with text "x" with one named "replaced". */
  const leafFn = (n: tstl.Expression): tstl.Expression | undefined => {
    if (n.kind === tstl.SyntaxKind.Identifier && (n as tstl.Identifier).text === "x") {
      return tstl.createIdentifier("replaced");
    }
    return undefined;
  };

  it("returns empty array for empty input", () => {
    const result = mapLuaStatements([], leafFn);
    expect(result).toEqual([]);
  });

  it("substitutes in ExpressionStatement", () => {
    const stmt = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const [result] = mapLuaStatements([stmt], leafFn);
    expect((result as tstl.ExpressionStatement).expression).toSatisfy(
      (e: tstl.Expression) =>
        e.kind === tstl.SyntaxKind.Identifier && (e as tstl.Identifier).text === "replaced",
    );
  });

  it("substitutes in VariableDeclarationStatement right side", () => {
    const stmt = tstl.createVariableDeclarationStatement(
      [tstl.createIdentifier("y")],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const varDecl = result as tstl.VariableDeclarationStatement;
    expect(varDecl.right).toBeDefined();
    expect((varDecl.right?.[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in AssignmentStatement right side", () => {
    const stmt = tstl.createAssignmentStatement(
      [tstl.createIdentifier("y") as tstl.AssignmentLeftHandSideExpression],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const assign = result as tstl.AssignmentStatement;
    expect((assign.right[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in AssignmentStatement TableIndexExpression left side", () => {
    const tblIndex = tstl.createTableIndexExpression(
      tstl.createIdentifier("x"),
      tstl.createIdentifier("key"),
    );
    const stmt = tstl.createAssignmentStatement(
      [tblIndex as tstl.AssignmentLeftHandSideExpression],
      [tstl.createNumericLiteral(1)],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const assign = result as tstl.AssignmentStatement;
    const lhs = assign.left[0] as tstl.TableIndexExpression;
    expect((lhs.table as tstl.Identifier).text).toBe("replaced");
  });

  it("recurses into DoStatement", () => {
    const inner = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const stmt = tstl.createDoStatement([inner]);
    const [result] = mapLuaStatements([stmt], leafFn);
    const doStmt = result as tstl.DoStatement;
    const innerResult = doStmt.statements[0] as tstl.ExpressionStatement;
    expect((innerResult.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in IfStatement condition and blocks", () => {
    const stmt = tstl.createIfStatement(
      tstl.createIdentifier("x"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const ifStmt = result as tstl.IfStatement;
    expect((ifStmt.condition as tstl.Identifier).text).toBe("replaced");
    const ifBlock = ifStmt.ifBlock.statements[0] as tstl.ExpressionStatement;
    expect((ifBlock.expression as tstl.Identifier).text).toBe("replaced");
    const elseBlock = (ifStmt.elseBlock as tstl.Block).statements[0] as tstl.ExpressionStatement;
    expect((elseBlock.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in chained IfStatement (elseif)", () => {
    const elseIf = tstl.createIfStatement(
      tstl.createIdentifier("x"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("y"))]),
    );
    const stmt = tstl.createIfStatement(
      tstl.createIdentifier("y"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("y"))]),
      elseIf,
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const ifStmt = result as tstl.IfStatement;
    const elseIfStmt = ifStmt.elseBlock as tstl.IfStatement;
    expect((elseIfStmt.condition as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in WhileStatement condition and body", () => {
    const stmt = tstl.createWhileStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("x"),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const whileStmt = result as tstl.WhileStatement;
    expect((whileStmt.condition as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = whileStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in RepeatStatement body and condition", () => {
    const stmt = tstl.createRepeatStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("x"),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const repeatStmt = result as tstl.RepeatStatement;
    expect((repeatStmt.condition as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = repeatStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ForStatement expressions but not controlVariable", () => {
    const stmt = tstl.createForStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("i"),
      tstl.createIdentifier("x"), // controlVariableInitializer
      tstl.createIdentifier("x"), // limitExpression
      tstl.createIdentifier("x"), // stepExpression
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const forStmt = result as tstl.ForStatement;
    // controlVariable should NOT be substituted
    expect((forStmt.controlVariable as tstl.Identifier).text).toBe("i");
    // Expressions should be substituted
    expect((forStmt.controlVariableInitializer as tstl.Identifier).text).toBe("replaced");
    expect((forStmt.limitExpression as tstl.Identifier).text).toBe("replaced");
    expect((forStmt.stepExpression as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = forStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ForInStatement expressions but not names", () => {
    const stmt = tstl.createForInStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      [tstl.createIdentifier("k")],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const forInStmt = result as tstl.ForInStatement;
    // names should NOT be substituted
    expect(forInStmt.names[0].text).toBe("k");
    // expressions should be substituted
    expect((forInStmt.expressions[0] as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = forInStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ReturnStatement expressions", () => {
    const stmt = tstl.createReturnStatement([tstl.createIdentifier("x")]);
    const [result] = mapLuaStatements([stmt], leafFn);
    const retStmt = result as tstl.ReturnStatement;
    expect((retStmt.expressions[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("does not mutate original statements", () => {
    const original = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const stmts = [original];
    mapLuaStatements(stmts, leafFn);
    // Original should be unchanged
    expect((original.expression as tstl.Identifier).text).toBe("x");
    expect(stmts).toHaveLength(1);
  });

  it("passes through BreakStatement unchanged", () => {
    const stmt = tstl.createBreakStatement();
    const [result] = mapLuaStatements([stmt], leafFn);
    expect(result.kind).toBe(tstl.SyntaxKind.BreakStatement);
  });

  it("passes through GotoStatement unchanged", () => {
    const stmt = tstl.createGotoStatement("lbl");
    const [result] = mapLuaStatements([stmt], leafFn);
    expect(result.kind).toBe(tstl.SyntaxKind.GotoStatement);
    expect((result as tstl.GotoStatement).label).toBe("lbl");
  });

  it("passes through LabelStatement unchanged", () => {
    const stmt = tstl.createLabelStatement("lbl");
    const [result] = mapLuaStatements([stmt], leafFn);
    expect(result.kind).toBe(tstl.SyntaxKind.LabelStatement);
    expect((result as tstl.LabelStatement).name).toBe("lbl");
  });
});
