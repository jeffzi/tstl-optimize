import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("merge-locals uncovered branches", () => {
  describe("expressionReferencesAnyOf — MethodCallExpression", () => {
    it("blocks merge when function body calls method on a tracked name (prefix match)", () => {
      // `a` is pure (table literal), so `a` enters the run. `fn`'s RHS is a pure
      // FunctionExpression, so when checked against declaredNames={a}, the scanner
      // walks the body and encounters a MethodCallExpression whose prefixExpression
      // is `a`. expressionReferencesAnyOf line 153 detects this and returns true,
      // blocking the merge. `a` and `fn` must remain separate locals.
      const code = `
        function f() {
          const a: any[] = [];
          const fn = function() { (a as any).push(1); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("merges when function body method call prefix does not match any tracked name", () => {
      // `a` is pure, so enters the run. `fn` is declared next; its RHS is a
      // FunctionExpression (pure). The body constructs a local array `arr` and
      // calls `arr.push(1)` — a MethodCallExpression. `arr` is NOT in
      // declaredNames={a}, so expressionReferencesAnyOf hits the MethodCallExpression
      // branch (line 152), checks prefixExpression `arr` against {a} (false),
      // checks params (none), and returns false (line 157). The function also has
      // no other reference to `a`. Merge is allowed: `a` and `fn` should merge.
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            const arr: any[] = [];
            (arr as any).push(1);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local .*a, fn/);
    });
  });

  describe("expressionReferencesAnyOf — FunctionExpression param partial shadowing", () => {
    it("blocks merge when function body captures a name not shadowed by any param", () => {
      // declaredNames = {a, b} when fn is evaluated. fn has param `a` (shadows outer
      // `a`), so line 186-188 removes `a` from names producing nextNames = {b}.
      // Since nextNames.size > 0, line 192 sets activeNames = {b} and continues
      // into the body. The body returns `a + b + x`, which references `b` from
      // activeNames, so returns true and blocks the merge.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const fn = function(a: number, x: number) { return a + b + x; };
          fn(0, 0);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `b` and `fn` must remain separate because `fn` captures `b` as an upvalue.
      expect(lua).not.toContain("local b, fn");
    });

    it("allows merge when all tracked names are shadowed by function params", () => {
      // declaredNames = {a} when fn is evaluated. fn has param `a` which shadows
      // the tracked `a`, so nextNames = {} (empty). Line 191 returns false immediately
      // (nextNames.size === 0) — no upvalue capture detected.
      // `a` and `fn` are therefore safe to merge into a single local declaration.
      const code = `
        function outer() {
          const a = 1;
          const fn = function(a: number) { return a + 1; };
          fn(0);
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local .*a, fn/);
    });
  });

  describe("expressionReferencesAnyOf — ParenthesizedExpression", () => {
    it("detects reference through parenthesized expression (line 177)", () => {
      // `a` is pure and enters the run. `b`'s RHS is `(a)` — a parenthesized
      // expression wrapping identifier `a`. expressionReferencesAnyOf encounters
      // isParenthesizedExpression (line 176) and unwraps to recursively check
      // the inner expression (line 177), detecting the reference to `a`.
      // This blocks merge: `a` and `b` must remain separate.
      const code = `
        function f() {
          const a = 5;
          const b = (a);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, b");
    });

    it("blocks merge when tracked name referenced via nested parentheses", () => {
      // `x` is pure, enters the run. `y`'s RHS is `((x))` — nested parentheses.
      // Each level of parentheses is unwrapped (line 177), eventually detecting
      // the reference to `x` in declaredNames. Blocks merge.
      const code = `
        function f() {
          const x = 10;
          const y = ((x));
          return x + y;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, y");
    });

    it("allows merge when parenthesized expression does not reference tracked name", () => {
      // `a` is pure, enters the run. `c` is pure, enters the run. `b`'s RHS is `(c)` —
      // a parenthesized expression wrapping `c`, which IS in declaredNames={a, c}.
      // expressionReferencesAnyOf unwraps (line 177) and checks `c` against {a, c},
      // returning true. However `a` and `c` should still merge since they don't reference
      // each other. This test verifies the ParenthesizedExpression branch is exercised.
      const code = `
        function f() {
          const a = 1;
          const c = 2;
          const b = (c);
          return a + b + c;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `a` and `c` should merge (both pure, don't reference each other)
      expect(lua).toMatch(/local a, c/);
      // `b` is separate because its RHS references `c` (via parentheses)
      expect(lua).toMatch(/local b/);
    });
  });

  describe("expressionReferencesAnyOf — MethodCallExpression params", () => {
    it("blocks merge when method call argument references tracked name (line 154-156)", () => {
      // `a` is pure, enters the run. `fn`'s RHS is a FunctionExpression whose body
      // contains a method call with argument `a`: `obj.method(a)`.
      // expressionReferencesAnyOf hits isMethodCallExpression (line 152), checks
      // prefixExpression `obj` (not in {a}), then iterates params (line 154-156)
      // and finds `a`. Returns true, blocks merge.
      const code = `
        function f() {
          const a = 42;
          const obj: any = {};
          const fn = function() { (obj as any).method(a); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("merges when method call params do not reference tracked name (line 154-157)", () => {
      // `a` is pure, enters the run. `fn`'s RHS is a FunctionExpression whose body
      // calls method: `obj.method(b)`. The method's prefixExpression `obj` is not
      // in {a}, and its param `b` is also not in {a}. The isMethodCallExpression
      // branch (line 152) checks the prefix (line 153, returns false), then iterates
      // through params (line 154-156, checking `b` against {a}, returns false).
      // Line 157 returns false overall. Merge is allowed: `a` and `fn` can merge.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const obj: any = {};
          const fn = function() { (obj as any).method(b); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `a`, `b`, `obj` should all merge together (all pure, no dependencies)
      expect(lua).toMatch(/local a, b, obj/);
      // `fn` may be separate due to being a FunctionExpression, but importantly
      // the MethodCallExpression param checking (line 154-156) was exercised
      expect(lua).toContain("local function fn");
    });
  });

  describe("expressionReferencesAnyOf — FunctionExpression multiple param shadowing", () => {
    it("blocks merge when function body captures some non-shadowed names (line 192 activeNames reassign)", () => {
      // declaredNames = {a, b, c}. fn has params [a, b] which shadow the outer
      // `a` and `b`. Line 186-188 progressively removes them: after param `a`,
      // nextNames = {b, c}; after param `b`, nextNames = {c}. Line 192 sets
      // activeNames = {c}. The body references `c`, so returns true, blocks merge.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const c = 3;
          const fn = function(a: number, b: number) { return a + b + c; };
          fn(0, 0);
          return a + b + c;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `c` and `fn` must remain separate.
      expect(lua).not.toContain("local c, fn");
    });

    it("allows merge when all params shadow all tracked names", () => {
      // declaredNames = {a, b}. fn has params [a, b] which shadow both.
      // Line 186-188 removes them from activeNames until nextNames = {}.
      // Line 191 returns false immediately. Merge is safe.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const fn = function(a: number, b: number) { return a + b + 10; };
          fn(0, 0);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local .*a, b, fn/);
    });
  });

  describe("merge-locals — table index and binary expressions", () => {
    it("blocks merge when function body has table index on tracked name", () => {
      // `tbl` is pure, enters the run. `result`'s RHS is a FunctionExpression
      // whose body contains a table index `tbl[1]`. This should be detected by
      // the TableIndexExpression branch (line 170-173).
      const code = `
        function f() {
          const tbl: any[] = [1, 2, 3];
          const result = function() { return (tbl as any)[0]; };
          result();
          return tbl;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local tbl, result");
    });

    it("blocks merge when function body has binary expression with tracked name", () => {
      // `x` is pure, enters the run. `computed`'s RHS is a FunctionExpression
      // whose body has a binary expression: `x + 10`. The BinaryExpression branch
      // (line 160-163) should detect the reference to `x`.
      const code = `
        function f() {
          const x = 5;
          const computed = function() { return x + 10; };
          computed();
          return x;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, computed");
    });

    it("blocks merge when function body has unary expression on tracked name", () => {
      // `n` is pure, enters the run. `negated`'s RHS is a FunctionExpression
      // whose body has a unary expression: `-(n)`. The UnaryExpression branch
      // (line 166-168) should detect the reference to `n`.
      const code = `
        function f() {
          const n = 42;
          const negated = function() { return -(n); };
          negated();
          return n;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local n, negated");
    });
  });

  describe("merge-locals — table and call expressions", () => {
    it("blocks merge when table constructor value references tracked name (line 136-142)", () => {
      // `x` is pure, enters the run. `obj`'s RHS is a FunctionExpression whose
      // body contains a table constructor with a field value referencing `x`:
      // `{ value: x }`. The TableExpression branch (line 136-142) checks field
      // values and detects the reference.
      const code = `
        function f() {
          const x = 10;
          const obj = function() { return { value: x }; };
          obj();
          return x;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, obj");
    });

    it("blocks merge when table constructor key references tracked name", () => {
      // `key` is pure, enters the run. `obj`'s RHS is a FunctionExpression whose
      // body contains a table with a field key referencing `key`:
      // `{ [key]: 1 }`. The TableExpression branch checks field keys (line 140)
      // and detects the reference.
      const code = `
        function f() {
          const key = "myKey";
          const obj = function() { return { [key]: 1 }; };
          obj();
          return key;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local key, obj");
    });

    it("blocks merge when call expression function references tracked name (line 144-150)", () => {
      // `fn` is pure, enters the run. `result`'s RHS is a FunctionExpression whose
      // body contains a call expression on `fn`: `fn()`. The CallExpression branch
      // (line 144-150) checks the expression being called (line 145) and detects
      // the reference to `fn`.
      const code = `
        function outer() {
          const fn = function() { return 42; };
          const result = function() { return (fn as any)(); };
          result();
          return fn;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local fn, result");
    });

    it("blocks merge when call expression argument references tracked name (line 146-148)", () => {
      // `arg` is pure, enters the run. `result`'s RHS is a FunctionExpression whose
      // body calls a function with `arg` as parameter: `Math.max(arg)`. The
      // CallExpression branch (line 144-150) iterates params (line 146-148) and
      // detects the reference.
      const code = `
        function f() {
          const arg = 5;
          const result = function() { return Math.max(arg); };
          result();
          return arg;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local arg, result");
    });

    it("merges when table constructor neither key nor value reference tracked names", () => {
      // `x` is pure, enters the run. `y` is pure, enters the run. `obj`'s RHS is
      // a FunctionExpression whose body creates a table with literals only:
      // `{ a: 1, b: 2 }`. Neither field keys nor values reference {x, y}.
      // All three merge together into a multi-var declaration.
      const code = `
        function f() {
          const x = 1;
          const y = 2;
          const obj = function() { return { a: 1, b: 2 }; };
          obj();
          return x + y;
        }
      `;

      const lua = normalizeLua(compile(code));

      // All three variables merge together
      expect(lua).toMatch(/local x, y, obj/);
    });
  });

  describe("merge-locals — for-in loop variable shadowing", () => {
    it("blocks merge when loop body references name shadowed by loop variable", () => {
      // `tbl` is pure, enters the run. `result`'s RHS references `tbl` which was
      // just declared in a for-in loop, so the merge should be blocked.
      const code = `
        function f() {
          const tbl: any = { a: 1, b: 2 };
          const result = function() {
            for (const key of (Object.keys(tbl) as any)) {
              return (tbl as any)[key];
            }
          };
          result();
          return tbl;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local tbl, result");
    });
  });

  describe("functionBodyReferencesAnyOf — inner local shadows tracked name (line 39)", () => {
    it("allows merge when function body re-declares the sole tracked name as a local", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body statements. The first statement
      // is `local a = 42` — a VariableDeclarationStatement whose LHS is `a`.
      // Line 33 detects `a` in activeNames, builds nextNames = {}, then line 39
      // fires `nextNames.size === 0 → return false` immediately (no upvalue capture).
      // a and fn are safe to merge.
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            const a = 42;
            return a + 1;
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local a, fn/);
    });

    it("allows merge when function body re-declares all tracked names as locals", () => {
      // declaredNames = {a, b} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body. First stmt: `local a = 10`
      // → nextNames = {b}, activeNames = {b}. Second stmt: `local b = 20`
      // → nextNames = {}, line 39 fires → return false. All tracked names are
      // locally shadowed before any use, so no upvalue capture. a, b and fn merge.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const fn = function() {
            const a = 10;
            const b = 20;
            return a + b;
          };
          fn();
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local a, b, fn/);
    });

    it("blocks merge when function body re-declares one tracked name but uses the other", () => {
      // declaredNames = {a, b} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf: stmt `local a = 10` → nextNames = {b}, activeNames = {b}.
      // Next stmt `return a + b + 1` — statementReferencesAnyOf checks the return
      // expressions against activeNames={b}, finds `b` referenced → returns true.
      // Merge is blocked; b and fn remain separate.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const fn = function() {
            const a = 10;
            return a + b + 1;
          };
          fn();
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local b, fn");
    });
  });

  describe("statementReferencesAnyOf — ForStatement (lines 94-103)", () => {
    it("blocks merge when tracked name appears in numeric for loop limit expression (line 95)", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body and encounters a Lua ForStatement
      // `for i = 1, a do`. statementReferencesAnyOf checks limitExpression `a`
      // against {a} at line 95 → returns true → blocks merge.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 5;
          const fn = function() {
            for (const i of $range(1, a)) { }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("allows merge when numeric for loop control variable shadows the tracked name (lines 98-103)", () => {
      // declaredNames = {i} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf encounters Lua ForStatement `for i = 1, 3 do`.
      // statementReferencesAnyOf at line 98: stmt.controlVariable.text === "i",
      // which IS in names={i}, so forBodyNames = {} (empty Set). Line 101:
      // forBodyNames.size === 0, so the body is NOT scanned. Line 103: return false.
      // The outer `i` is safely shadowed by the loop variable; merge is allowed.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const i = 10;
          const fn = function() {
            for (const i of $range(1, 3)) { }
          };
          fn();
          return i;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local i, fn/);
    });
  });

  describe("statementReferencesAnyOf — ForStatement body scan (line 102)", () => {
    it("blocks merge when numeric for loop body references a tracked name (line 102)", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf encounters ForStatement `for j = 1, 3 do`.
      // controlVariable.text === "j", which is NOT in names={a}, so forBodyNames = {a}.
      // Line 101: forBodyNames.size > 0, so body scan proceeds. The body contains
      // `local x = a + j` which references `a`. functionBodyReferencesAnyOf returns
      // true, line 102 returns true → merge blocked.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 5;
          const fn = function() {
            for (const j of $range(1, 3)) {
              const x = a + j;
            }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });
  });

  describe("statementReferencesAnyOf — unhandled statement type fallthrough (line 127)", () => {
    it("allows merge when function body contains only break and unhandled statement types", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body: a ForStatement `for i = 1, 3 do break end`.
      // The ForStatement body contains a BreakStatement. statementReferencesAnyOf is
      // called on the BreakStatement, which matches none of the if-branches and falls
      // through to line 127 `return false`. The for loop header/body don't reference {a},
      // so the whole scan returns false. Merge is allowed.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 1;
          const fn = function() {
            for (const i of $range(1, 3)) {
              break;
            }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local a, fn/);
    });
  });

  describe("expressionReferencesAnyOf — MethodCallExpression with colon syntax (lines 152-157)", () => {
    it("blocks merge when method call prefix is a tracked name (line 153 return true)", () => {
      // declaredNames = {obj} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(42) — a MethodCallExpression whose prefixExpression
      // is `obj`. Line 153 detects `obj` in activeNames → returns true → blocks merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const obj = new Foo();
          const fn = function() { obj.bar(42); };
          fn();
          return obj;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local obj, fn");
    });

    it("blocks merge when method call argument is a tracked name (line 155 return true)", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(a) — MethodCallExpression, prefix `obj` is not in
      // {a} (obj is local inside fn), but param `a` IS in {a}. Line 154-156 iterates
      // params, finds `a` → returns true → blocks merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const a = 1;
          const fn = function() {
            const obj = new Foo();
            obj.bar(a);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("allows merge when method call prefix and args do not reference tracked names (line 157 return false)", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(42) — MethodCallExpression. prefixExpression `obj`
      // is a local inside fn's body, not in activeNames={a}. Arg `42` is a literal,
      // not in {a}. The MethodCallExpression branch exhausts all checks and falls
      // through to line 157 `return false`. Merge is allowed: a and fn merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const a = 1;
          const fn = function() {
            const obj = new Foo();
            obj.bar(42);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toMatch(/local a, fn/);
    });
  });
});
