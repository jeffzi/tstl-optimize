import fc from "fast-check";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../../src/rules/dead-local";
import { collectUndefinedSymbolIdNames } from "../../../src/rules/dead-local/access";
import { compile, EMPTY_SOURCE_FILE, expectLuaSnippets, normalizeLua } from "../../helpers";

describe("dead-local", () => {
  function createLuaFile(statements: tstl.Statement[]): tstl.File {
    return tstl.createFile(statements, new Set<tstl.LuaLibFeature>(), "");
  }

  function expectVariableDeclarationStatement(
    node: tstl.Statement | undefined,
  ): tstl.VariableDeclarationStatement {
    if (!node || !tstl.isVariableDeclarationStatement(node)) {
      throw new Error("Expected variable declaration statement");
    }
    return node;
  }

  function expectFunctionExpression(node: tstl.Expression | undefined): tstl.FunctionExpression {
    if (!node || !tstl.isFunctionExpression(node)) {
      throw new Error("Expected function expression");
    }
    return node;
  }

  function toSymbolId(value: number): tstl.SymbolId {
    // tstl.SymbolId is a branded number type; this cast is intentional as
    // the type system cannot express the branding at runtime. We construct the ID
    // directly since we control the input.
    return value as tstl.SymbolId;
  }

  it("removes unused inline arg temp", () => {
    const lua = compile(
      `
      /** @inline */
      function double(x: number): number { return x * 2; }
      const result = double(21);
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    // ____inline_arg_0 should be eliminated as an unused temp
    expect(lua).not.toContain("____inline_arg_");
  });

  it("preserves variable that is read in same scope", () => {
    const lua = compile("function f() { const x = 1; return x; }", {
      pluginOptions: { rules: { "constant-propagation": false } },
    });
    expect(lua).toContain("x = 1");
  });

  it("removes unused variable with pure RHS (literal)", () => {
    const lua = compile("function f() { const x = 42; }", {
      pluginOptions: { rules: { "constant-propagation": false } },
    });
    expect(lua).not.toContain("x = 42");
  });

  it("preserves variable whose RHS has a side effect (call expression)", () => {
    const lua = compile(
      `
      declare function someFunc(): number;
      function f() { const x = someFunc(); }
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    // The call must still execute; the whole declaration stays
    expect(lua).toContain("x = someFunc()");
  });

  it("does NOT remove module-level unused locals", () => {
    // Top-level const — module scope, out of scope for dead-local
    const lua = compile("const x = 1;", {
      pluginOptions: { rules: { "constant-propagation": false } },
    });
    expect(lua).toContain("x = 1");
  });

  it("does NOT touch multi-LHS declarations", () => {
    // local a, b = f() — must not be removed
    const lua = compile(
      `
      declare function pair(): [number, number];
      function f() {
        const [a, b] = pair();
        return a + b;
      }
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    expect(lua).toMatch(/local a, b\b/);
    expect(lua).toContain("a + b");
  });

  it("preserves variable used inside a nested closure", () => {
    const lua = compile(
      `
      function outer() {
        const x = 1;
        const fn = () => x;
        return fn();
      }
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    // x is captured by the closure — must not be removed
    // (merge-locals may merge x and fn into one statement, but x must still be declared)
    expect(lua).toMatch(/local x[,\s]/);
  });

  it("removes unused local function declaration (post-inline residue)", () => {
    const lua = compile(
      `
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r1 = add(1, 2);
      const r2 = add(3, 4);
    `,
      { pluginOptions: { rules: { "constant-propagation": false } } },
    );
    expect(lua).not.toContain("local function add");
  });

  it("respects config to disable the rule", () => {
    const lua = compile("function f() { const x = 42; }", {
      pluginOptions: { rules: { "constant-propagation": false, "dead-local": false } },
    });
    expect(lua).toContain("x = 42");
  });

  describe("when removing unused locals in nested function expressions", () => {
    it.each([
      {
        name: "callback passed as a call argument",
        source: `
          declare function run(fn: () => number): void;
          function outer() {
            run(function(): number {
              const unused = 42;
              const result = 1;
              return result;
            });
          }
        `,
      },
      {
        name: "function stored in a table value",
        source: `
          function outer() {
            const obj = { fn: function(): number {
              const unused = 42;
              const result = 1;
              return result;
            } };
            return obj;
          }
        `,
      },
      {
        name: "IIFE callee",
        source: `
          function outer() {
            (function() {
              const unused = 42;
              const result = 1;
              return result;
            })();
          }
        `,
      },
    ])("removes unused local inside $name", ({ source }) => {
      const lua = compile(source, { pluginOptions: { rules: { "constant-propagation": false } } });

      expect(lua).not.toContain("unused");
      expect(lua).toContain("result");
    });
  });

  describe("when handling write-only locals (assignment without read)", () => {
    it("preserves initializer when the first later assignment reads the local", () => {
      const lua = compile(
        `
        function f() {
          let i = 0;
          i += 1;
          return i;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );

      expect(lua).toContain("local i = 0");
      expect(lua).toContain("i = i + 1");
    });

    it("preserves initializer when a closure reads the local before a later write", () => {
      const lua = normalizeLua(
        compile(
          `
          function f() {
            let x = 1;
            const g = () => x;
            const y = g();
            x = 2;
            return y;
          }
        `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = g()");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });

    it("ignores deferred nested-function writes when deciding whether to drop an initializer", () => {
      const lua = compile(
        `
        function f() {
          let s = "A";
          const touch = (x: string) => {
            s = x;
          };
          s += "B";
          touch("C");
          return s;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );

      expect(lua).toContain('local s = "A"');
      expect(lua).toContain('s = s .. "B"');
    });

    it("preserves declaration when local is assigned after initialization", () => {
      const lua = compile(
        `
        function f() {
          let x = 1;
          x = 5;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      // The local must survive, but the dead pure initializer should be removed.
      expect(lua).toContain("local x");
      expect(lua).not.toMatch(/local x\s*=\s*1/);
      expect(lua).toContain("x = 5");
    });

    it("preserves declaration when local with impure RHS is assigned", () => {
      const lua = compile(
        `
        declare function foo(): number;
        declare function bar(): number;
        function f() {
          let x = foo();
          x = bar();
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      // x is assigned to, so declaration must be kept (even though RHS is impure)
      expect(lua).toContain("local x");
      expect(lua).toContain("foo()");
    });

    it("still removes unused local when NOT followed by assignment", () => {
      const lua = compile(
        `
        function f() {
          const x = 1;
          const y = 2;
          return y;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      // x is never read and never assigned — should be eliminated
      expect(lua).not.toContain("x");
      expect(lua).toContain("y");
    });

    it("preserves declaration when local is assigned and then read", () => {
      const lua = compile(
        `
        function f() {
          let x = 1;
          x = 2;
          return x;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      // x is assigned and read — declaration must be kept, but the dead pure initializer should go.
      expect(lua).toContain("local x");
      expect(lua).not.toMatch(/local x\s*=\s*1/);
      expect(lua).toContain("x = 2");
    });

    it("preserves initializer when the first read is parenthesized before a later write", () => {
      const lua = normalizeLua(
        compile(
          `
        function f(flag: boolean) {
          let x = 1;
          const y = (x);
          if (flag) {
            x = 2;
          }
          return y;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = x");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });

    it("preserves initializer when the first read appears in a conditional expression", () => {
      const lua = normalizeLua(
        compile(
          `
        function f(flag: boolean) {
          let x = 1;
          const y = flag ? x : 0;
          x = 2;
          return y;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = flag and x or 0");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });

    it("preserves initializer when the first write is inside an if branch", () => {
      const lua = normalizeLua(
        compile(
          `
        function f(flag: boolean) {
          let called = false;
          if (flag) {
            called = true;
          }
          return called;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local called = false");
      expect(lua).toContain("called = true");
    });

    it("preserves initializer when the first write is inside a for-loop body", () => {
      const lua = normalizeLua(
        compile(
          `
        declare const n: number;
        function f() {
          let called = false;
          for (let i = 0; i < n; i++) {
            called = true;
          }
          return called;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local called = false");
      expect(lua).toContain("called = true");
    });

    it("drops initializer when the first write is unconditional (do-block)", () => {
      const lua = normalizeLua(
        compile(
          `
        function f() {
          let x = 1;
          {
            x = 2;
          }
          return x;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local x");
      expect(lua).not.toMatch(/local x\s*=\s*1/);
      expect(lua).toContain("x = 2");
    });
  });

  describe("when removing unused locals in branching statements", () => {
    it.each([
      {
        name: "if/else branches",
        source: `
          function f() {
            if (true) {
              const unused = 42;
              const result = 1;
              return result;
            } else {
              const deadCode = 99;
              const value = 2;
              return value;
            }
          }
        `,
        expectedPresent: ["if true then", "result", "value", "else"],
        expectedMissing: ["unused", "deadCode"],
      },
      {
        name: "elseif branches",
        source: `
          function f() {
            if (false) {
              return 2;
            } else if (true) {
              const unused3 = 3;
              const result = 4;
              return result;
            }
          }
        `,
        expectedPresent: ["elseif true then", "result"],
        expectedMissing: ["unused3"],
      },
      {
        name: "while-loop bodies",
        source: `
          function f() {
            let x = 0;
            while (x < 10) {
              const unused = 42;
              const value = x + 1;
              x = value;
            }
          }
        `,
        expectedPresent: ["while x < 10 do", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "repeat-loop bodies",
        source: `
          function f() {
            let x = 10;
            do {
              const unused = 42;
              const value = x - 1;
              x = value;
            } while (x > 0);
          }
        `,
        expectedPresent: ["repeat", "until", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "for-loop bodies",
        source: `
          declare const items: number[];
          function f() {
            for (let i = 0; i < items.length; i++) {
              const unused = 42;
              const value = items[i] * 2;
              if (value > 10) return value;
            }
          }
        `,
        expectedPresent: ["items", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "for-in loop bodies",
        source: `
          declare const obj: Record<string, number>;
          function f() {
            for (const key in obj) {
              const unused = 42;
              const val = obj[key];
              if (val > 0) return val;
            }
          }
        `,
        expectedPresent: ["for", "obj", "val"],
        expectedMissing: ["unused"],
      },
      {
        name: "do-block bodies",
        source: `
          function f() {
            do {
              const unused = 42;
              const value = 1;
              return value;
            } while (false);
          }
        `,
        expectedPresent: ["do", "value"],
        expectedMissing: ["unused"],
      },
    ])("removes unused locals inside $name", ({ expectedMissing, expectedPresent, source }) => {
      const lua = compile(source, { pluginOptions: { rules: { "constant-propagation": false } } });
      expectLuaSnippets(lua, { contains: expectedPresent, excludes: expectedMissing });
    });
  });

  describe("when locals are read through complex expressions", () => {
    it("preserves locals read through conditional and parenthesized expressions", () => {
      const lua = compile(
        `
        function f(flag: boolean) {
          const x = 1;
          const y = (flag ? x : 2);
          return (y);
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );

      expect(lua).toContain("x = 1");
      expect(lua).toContain("return y");
    });

    it("preserves locals read from table keys and values", () => {
      const lua = normalizeLua(
        compile(
          `
        function f() {
          const key = "value";
          const data = { [key]: key };
          return data[key];
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain('local key = "value"');
      expect(lua).toContain("return data[key]");
    });

    it("preserves locals read through computed assignment targets", () => {
      const lua = normalizeLua(
        compile(
          `
        function f(arr: number[]) {
          let index = 0;
          arr[index] = arr[index] + 1;
          return index;
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local index = 0");
      expect(lua).toContain("arr[index + 1] = arr[index + 1] + 1");
      expect(lua).toContain("return index");
    });

    it("preserves unused function-expression declarations inside nested scopes", () => {
      const lua = normalizeLua(
        compile(
          `
        function outer() {
          if (true) {
            const keep = function() {
              return 1;
            };
          }
        }
      `,
          { pluginOptions: { rules: { "constant-propagation": false } } },
        ),
      );

      expect(lua).toContain("local function keep()");
      expect(lua).toContain("return 1");
    });
  });

  describe("when transforming pre-built Lua AST nodes", () => {
    function runSourceFileVisitor(node: tstl.Node): tstl.Node {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitorFn = Reflect.get(visitors, ts.SyntaxKind.SourceFile);
      if (typeof visitorFn !== "function") {
        throw new Error("Expected visitor to be a function");
      }

      return Reflect.apply(visitorFn, undefined, [
        EMPTY_SOURCE_FILE,
        { superTransformNode: () => node },
      ]);
    }

    it("preserves an initializer when the first later read is parenthesized inside a nested do block", () => {
      const xSym = toSymbolId(101);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createDoStatement([
          tstl.createVariableDeclarationStatement(
            [tstl.createIdentifier("y")],
            [tstl.createParenthesizedExpression(tstl.createIdentifier("x", undefined, xSym))],
          ),
        ]),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);
      const transformed = runSourceFileVisitor(file);

      if (!tstl.isFile(transformed)) {
        throw new Error("Expected source-file visitor to return a Lua file");
      }

      const fnDecl = expectVariableDeclarationStatement(transformed.statements[0]);
      const fnExpr = expectFunctionExpression(fnDecl.right?.[0]);
      const xDecl = expectVariableDeclarationStatement(fnExpr.body.statements[0]);

      expect(xDecl.left).toHaveLength(1);
      expect(xDecl.left[0].text).toBe("x");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(xDecl.right![0])).toBe(true);
    });

    it("preserves an initializer when the first later read is conditional inside a nested do block", () => {
      const xSym = toSymbolId(102);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createDoStatement([
          tstl.createVariableDeclarationStatement(
            [tstl.createIdentifier("y")],
            [
              tstl.createConditionalExpression(
                tstl.createBooleanLiteral(true),
                tstl.createIdentifier("x", undefined, xSym),
                tstl.createNumericLiteral(0),
              ),
            ],
          ),
        ]),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file);
      if (!tstl.isFile(transformed)) {
        throw new Error(`Expected File, got ${transformed?.kind}`);
      }
      const fnDecl = transformed.statements[0];
      if (!tstl.isVariableDeclarationStatement(fnDecl)) {
        throw new Error(`Expected VariableDeclarationStatement, got ${fnDecl?.kind}`);
      }
      const fnExpr = fnDecl.right?.[0];
      if (!fnExpr || !tstl.isFunctionExpression(fnExpr)) {
        throw new Error(`Expected FunctionExpression, got ${fnExpr?.kind}`);
      }
      const xDecl = fnExpr.body.statements[0];
      if (!tstl.isVariableDeclarationStatement(xDecl)) {
        throw new Error(`Expected VariableDeclarationStatement, got ${xDecl?.kind}`);
      }

      expect(xDecl.left).toHaveLength(1);
      expect(xDecl.left[0].text).toBe("x");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(xDecl.right![0])).toBe(true);
    });

    it("preserves an initializer when a raw numeric-for step expression reads the local before a later write", () => {
      const stepSym = toSymbolId(103);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("step", undefined, stepSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createForStatement(
          tstl.createBlock([]),
          tstl.createIdentifier("i"),
          tstl.createNumericLiteral(0),
          tstl.createNumericLiteral(4),
          tstl.createIdentifier("step", undefined, stepSym),
        ),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("step", undefined, stepSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file);
      if (!tstl.isFile(transformed)) {
        throw new Error(`Expected File, got ${transformed?.kind}`);
      }
      const fnDecl = transformed.statements[0];
      if (!tstl.isVariableDeclarationStatement(fnDecl)) {
        throw new Error(`Expected VariableDeclarationStatement, got ${fnDecl?.kind}`);
      }
      const fnExpr = fnDecl.right?.[0];
      if (!fnExpr || !tstl.isFunctionExpression(fnExpr)) {
        throw new Error(`Expected FunctionExpression, got ${fnExpr?.kind}`);
      }
      const stepDecl = fnExpr.body.statements[0];
      if (!tstl.isVariableDeclarationStatement(stepDecl)) {
        throw new Error(`Expected VariableDeclarationStatement, got ${stepDecl?.kind}`);
      }

      expect(stepDecl.left).toHaveLength(1);
      expect(stepDecl.left[0].text).toBe("step");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(stepDecl.right![0])).toBe(true);
    });
  });

  describe("property-based invariants", () => {
    const FC_OPTS: Parameters<typeof fc.assert>[1] = { numRuns: 20 };

    it("preserves side-effectful RHS even when the local is unused (any call count)", () => {
      // Core invariant: dead-local must never drop a side-effectful initializer.
      // We generate N unused locals each calling a side-effectful function and
      // verify the calls survive in the emitted Lua.
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
          const unusedDecls = Array.from(
            { length: n },
            (_, i) => `        const unused${i} = sideEffect();`,
          ).join("\n");
          const lua = compile(
            `
              declare function sideEffect(): number;
              function f(): void {
${unusedDecls}
              }
              f();
            `,
            { pluginOptions: { rules: { "constant-propagation": false } } },
          );
          // Each sideEffect() call must survive (either as a bare call statement or in a stripped-decl form).
          const callCount = (lua.match(/sideEffect\(\)/g) ?? []).length;
          return callCount === n;
        }),
        FC_OPTS,
      );
    }, 20_000);

    it("drops any number of consecutive pure unused locals", () => {
      // Pure literals with no read-sites are droppable; verify no ____unused name leaks.
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
          const pureDecls = Array.from(
            { length: n },
            (_, i) => `        const pure${i} = ${i + 1};`,
          ).join("\n");
          const lua = compile(
            `
              declare function obs(): void;
              function f(): void {
${pureDecls}
                obs();
              }
              f();
            `,
            { pluginOptions: { rules: { "constant-propagation": false } } },
          );
          for (let i = 0; i < n; i++) {
            if (lua.includes(`pure${i}`)) return false;
          }
          return lua.includes("obs()");
        }),
        FC_OPTS,
      );
    }, 20_000);
  });

  describe("dead-local — interaction with other rules", () => {
    it("inline arg temp is eliminated after inlining runs (dead-local + inline)", () => {
      // inline introduces ____inline_arg_N temps; dead-local must remove them.
      const lua = compile(
        `
        /** @inline */
        function add(a: number, b: number): number { return a + b; }
        const r = add(10, 20);
        declare function use(n: number): void;
        use(r);
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      expect(lua).not.toContain("____inline_arg_");
      // The inlined result must survive (constant-folding may evaluate 10+20 to 30)
      expect(lua.includes("10 + 20") || lua.includes("30")).toBe(true);
    });

    it("closure capturing an unused local still retains the captured ref (adversarial indirection)", () => {
      // A local that is read only inside an immediately-returned closure must not be dropped.
      const lua = compile(
        `
        function makeGetter(n: number): () => number {
          const captured = n + 1;
          return () => captured;
        }
        declare function use(f: () => number): void;
        use(makeGetter(5));
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      expect(lua).toContain("captured");
    });

    it("impure RHS is preserved even when local is never read", () => {
      // dead-local keeps impure declarations intact (local neverRead = sideEffect() survives);
      // the call must not be silently discarded.
      const lua = compile(
        `
        declare function sideEffect(): number;
        function f(): void {
          const neverRead = sideEffect();
        }
        f();
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      expect(lua).toContain("sideEffect()");
    });
  });

  describe("collectUndefinedSymbolIdNames", () => {
    it("collects names from identifiers with undefined symbolId via forEachAccess", () => {
      const withId = tstl.createIdentifier("tracked", undefined, toSymbolId(1));
      const withoutId = tstl.createIdentifier("untracked");

      const stmts: tstl.Statement[] = [
        tstl.createExpressionStatement(withId),
        tstl.createExpressionStatement(withoutId),
      ];

      const names = new Set<string>();
      collectUndefinedSymbolIdNames(stmts, names);

      expect(names.has("untracked")).toBe(true);
      expect(names.has("tracked")).toBe(true);
    });

    it("collects names from symbolId-less reads in assignment RHS", () => {
      const lhs = tstl.createIdentifier("target", undefined, toSymbolId(10));
      const rhs = tstl.createIdentifier("noSymbol");
      const stmt = tstl.createAssignmentStatement(lhs, rhs);

      const names = new Set<string>();
      collectUndefinedSymbolIdNames([stmt], names);

      expect(names.has("noSymbol")).toBe(true);
      expect(names.has("target")).toBe(false);
    });

    it("returns empty set when all identifiers have symbolIds", () => {
      const lhs = tstl.createIdentifier("a", undefined, toSymbolId(1));
      const rhs = tstl.createIdentifier("b", undefined, toSymbolId(2));
      const stmts: tstl.Statement[] = [tstl.createAssignmentStatement(lhs, rhs)];

      const names = new Set<string>();
      collectUndefinedSymbolIdNames(stmts, names);

      expect(names.size).toBe(0);
    });
  });
});
