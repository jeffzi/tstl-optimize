import fc from "fast-check";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile, compileWithDiagnostics, normalizeLua } from "../helpers";

describe("optimize rule interactions", () => {
  describe("when localizer works with block-scoped code", () => {
    it("hoists repeated chains from inside do...end to module scope", () => {
      const lua = compile(
        `
        declare const x: number;
        {
          const a = Math.ceil(x);
          const b = Math.ceil(x + 1);
          const c = Math.ceil(x + 2);
        }
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("hoists chains from inside nested blocks", () => {
      const lua = compile(
        `
        declare const x: number;
        { { const a = Math.ceil(x); const b = Math.ceil(x + 1); } }
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain("local ____math_ceil = math.ceil");
      expect(normalizedLua).toContain("local a = ____math_ceil(x)");
      expect(normalizedLua).toContain("local b = ____math_ceil(x + 1)");
    });

    it("does not hoist chains rooted at block-local variables", () => {
      const lua = compile(
        `
        {
          const obj = { nested: { value: 1 } };
          const a = obj.nested.value;
          const b = obj.nested.value;
          const c = obj.nested.value;
        }
      `,
        {
          pluginOptions: {
            rules: { localizer: { scope: "module", include: ["obj"] } },
          },
        },
      );
      expect(lua).not.toContain("____obj");
      expect(lua).toContain("obj.nested.value");
    });
  });

  describe("when math-intrinsics and inline rules interact", () => {
    it("replaces Math functions inside inlined expression body", () => {
      const lua = compile(`
        /** @inline */
        function fastFloor(x: number) { return Math.floor(x); }
        declare const v: number;
        const r = fastFloor(v);
      `);
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).not.toContain("fastFloor(v)");
      expect(normalizedLua).toContain("math.floor(v)");
      expect(normalizedLua).toContain("v - v % 1");
    });

    it("replaces Math functions inside inlined do...end block", () => {
      const lua = compile(`
        /** @inline */
        function doFloor(x: number): void {
          const y = Math.floor(x);
          const z = y + 1;
        }
        declare const v: number;
        doFloor(v);
      `);
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain(
        "local y = (____inline_arg_0 == math.huge or ____inline_arg_0 == -(math.huge)) and math.floor(____inline_arg_0) or ____inline_arg_0 - ____inline_arg_0 % 1",
      );
      expect(normalizedLua).not.toContain("doFloor(v)");
    });
  });

  describe("when localizer and inline rules interact", () => {
    it("processes property chains and calls from inlined body", () => {
      const src = `
        declare const obj: { pos: { x: number } };
        /** @inline */
        function getX() { return obj.pos.x; }
        const a = getX(); const b = getX(); const c = getX();
      `;
      const lua = compile(src, {
        pluginOptions: { rules: { localizer: { scope: "module", include: ["obj"] } } },
      });
      expect(lua).toContain("____obj_pos_x");
      expect(lua).not.toContain("getX(");
    });

    it("hoists repeated chains from inside inlined do...end block", () => {
      const src = `
        /** @inline */
        function doWork(x: number): void {
          const a = Math.floor(x);
          const b = Math.floor(x + 1);
          const c = Math.floor(x + 2);
        }
        declare const v: number;
        doWork(v);
      `;
      const lua = compile(src, {
        pluginOptions: { rules: { localizer: { scope: "module" } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      });
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain("local ____math_floor = math.floor");
      expect(normalizedLua).toContain("local a = ____math_floor(____inline_arg_0)");
      expect(normalizedLua).toContain("local b = ____math_floor(____inline_arg_0 + 1)");
      expect(normalizedLua).toContain("local c = ____math_floor(____inline_arg_0 + 2)");
      expect(normalizedLua).not.toContain("doWork(v)");
    });
  });

  // ---------------------------------------------------------------------------
  // inline + conditional-compilation
  // ---------------------------------------------------------------------------

  describe("when inline and conditional-compilation interact", () => {
    function ccOpts(
      constants: Record<string, { env: string; default: boolean | number | string }>,
    ) {
      return { pluginOptions: { rules: { "conditional-compilation": { constants } } } };
    }

    it("removes dead branch inside inlined void function body while preserving live statements", () => {
      // s is used in both doLog(s) and doWork(s) → canInline creates a temp arg.
      // With DEBUG=false the if-block is stripped, but doWork(____inline_arg_0) remains.
      const lua = compile(
        `
        declare function doLog(s: string): void;
        declare function doWork(s: string): void;
        declare const DEBUG: boolean;
        /** @inline */
        function process(s: string): void {
          if (DEBUG) { doLog(s); }
          doWork(s);
        }
        declare const msg: string;
        process(msg);
        `,
        ccOpts({ DEBUG: { env: "TSTL_OPT_DEAD_BRANCH", default: false } }),
      );
      const normalized = normalizeLua(lua);
      expect(normalized).not.toContain("doLog");
      expect(normalized).toContain("doWork(____inline_arg_0)");
      expect(normalized).not.toContain("process(msg)");
    });

    it("removes entire inlined body and arg temp when all statements are dead branches", () => {
      const lua = compile(
        `
        declare function doLog(s: string): void;
        declare const DEBUG: boolean;
        /** @inline */
        function maybeLog(s: string): void {
          if (DEBUG) { doLog(s); }
        }
        declare const msg: string;
        maybeLog(msg);
        `,
        ccOpts({ DEBUG: { env: "TSTL_OPT_DEAD_BRANCH", default: false } }),
      );
      const normalized = normalizeLua(lua);
      expect(normalized).not.toMatch(/\bdo\b/);
      expect(normalized).not.toContain("____inline_arg_");
      expect(normalized).not.toContain("maybeLog");
      expect(normalized).not.toContain("doLog");
    });

    it("fully inlines return sites whose body is stripped before param mapping", () => {
      const lua = compile(
        `
        declare const DEBUG: boolean;
        /** @inline */
        function identityAfterCc(value: number): number {
          if (DEBUG) {
            const logged = value;
          }
          return value;
        }

        function run(input: number): number {
          return identityAfterCc(input);
        }
        `,
        ccOpts({ DEBUG: { env: "TSTL_OPT_DEAD_BRANCH_RETURN", default: false } }),
      );
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("local ____inline_arg_0 = input");
      expect(normalized).toContain("return ____inline_arg_0");
      expect(normalized).not.toContain("identityAfterCc(input)");
      expect(normalized).not.toContain("function identityAfterCc");
    });

    it("emits discard assignment for side-effectful args when inlined body is fully stripped", () => {
      // When CC strips the entire body, side-effectful args must still evaluate.
      // Use a collision-safe discard temp (____inline_result_N) instead of bare `_`
      // to avoid shadowing any user-defined underscore local.
      const lua = compile(
        `
        declare function doLog(s: string): void;
        declare function sideEffect(): string;
        declare const DEBUG: boolean;
        /** @inline */
        function maybeLog(s: string): void {
          if (DEBUG) { doLog(s); }
        }
        maybeLog(sideEffect());
        `,
        ccOpts({ DEBUG: { env: "TSTL_OPT_DEAD_BRANCH_SIDE", default: false } }),
      );
      const normalized = normalizeLua(lua);
      expect(normalized).toMatch(/local ____inline_result_\d+ = sideEffect\(\)/);
      expect(normalized).not.toContain("local _ =");
      expect(normalized).not.toContain("maybeLog");
      expect(normalized).not.toContain("doLog");
    });
  });

  // ---------------------------------------------------------------------------
  // inline + dead-local
  // ---------------------------------------------------------------------------

  describe("when inline and dead-local interact", () => {
    it("preserves arg temp that is read inside the substituted do...end block", () => {
      // x is used twice (x*x and sq+x) → canInline creates ____inline_arg_0 = n.
      // dead-local must NOT remove it because collectReadSymbols recurses into the do...end.
      const lua = compile(`
        /** @inline */
        function sumSquare(x: number): number {
          const sq = x * x;
          return sq + x;
        }
        declare const n: number;
        const r = sumSquare(n);
      `);
      expect(lua).toContain("____inline_arg_0 = n");
      expect(lua).not.toContain("sumSquare(n)");
    });
  });

  // ---------------------------------------------------------------------------
  // inline + merge-locals
  // ---------------------------------------------------------------------------

  describe("when inline and merge-locals interact", () => {
    it("coalesces inline-produced pure local with adjacent pure locals inside a function body", () => {
      // identity(10) → expression target with pure literal arg → inlines to: local a = 10.
      // b=2 and c=3 are also pure literals. merge-locals sees three consecutive pure
      // single-var locals inside f() and merges them into local a, b, c = 10, 2, 3.
      const lua = compile(`
        /** @inline */
        function identity(x: number): number { return x; }
        function f(): number {
          const a = identity(10);
          const b = 2;
          const c = 3;
          return a + b + c;
        }
      `);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("a, b, c = 10, 2, 3");
      expect(normalized).not.toContain("identity(10)");
    });
  });

  // ---------------------------------------------------------------------------
  // inline rejection: class methods
  // ---------------------------------------------------------------------------

  describe("when @inline is annotated on a class method", () => {
    it("does not inline class method calls because they are not module-scope declarations", () => {
      const lua = compile(`
        class Calc {
          /** @inline */
          add(a: number, b: number): number { return a + b; }
        }
        declare const calc: Calc;
        const r = calc.add(3, 4);
      `);
      // TSTL emits method calls with colon syntax; call site must survive un-inlined.
      expect(lua).toContain("calc:add(3, 4)");
      expect(lua).not.toContain("____inline_arg_");
    });
  });

  // ---------------------------------------------------------------------------
  // fast-check property tests
  // ---------------------------------------------------------------------------

  // Compilation is ~30–50 ms per run; keep numRuns small so the suite stays well under 30s.
  const FC_OPTS: Parameters<typeof fc.assert>[1] = { numRuns: 20 };

  describe("inline rule properties", () => {
    it("always emits a diagnostic for recursive @inline functions", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4 }), (n) => {
          const params = Array.from({ length: n }, (_, i) => `p${i}: number`).join(", ");
          const zeros = Array.from({ length: n }, () => "0").join(", ");
          const args = Array.from({ length: n }, (_, i) => `p${i}`).join(", ");
          const { diagnostics } = compileWithDiagnostics(`
              /** @inline */
              function recurse(${params}): number { return recurse(${args}); }
              const r = recurse(${zeros});
            `);
          return diagnostics.some((d) => {
            const msg =
              typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
            return /recursive/i.test(msg);
          });
        }),
        FC_OPTS,
      );
    }, 20_000);

    it("assigns arg temps in left-to-right parameter order for multi-arg side-effectful calls", () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 4 }), (n) => {
          const params = Array.from({ length: n }, (_, i) => `p${i}: number`).join(", ");
          const body = Array.from({ length: n }, (_, i) => `p${i}`).join(" + ");
          const declares = Array.from(
            { length: n },
            (_, i) => `declare function sideEffect${i}(): number;`,
          ).join("\n");
          const callArgs = Array.from({ length: n }, (_, i) => `sideEffect${i}()`).join(", ");
          const lua = compile(`
              ${declares}
              /** @inline */
              function add(${params}): number { return ${body}; }
              const r = add(${callArgs});
            `);
          for (let i = 0; i < n - 1; i++) {
            const posI = lua.indexOf(`____inline_arg_${i} = sideEffect${i}()`);
            const posNext = lua.indexOf(`____inline_arg_${i + 1} = sideEffect${i + 1}()`);
            if (posI < 0 || posNext < 0 || posI >= posNext) return false;
          }
          return true;
        }),
        FC_OPTS,
      );
    }, 20_000);

    it("inlines a function that captures a module-level const (upvalue access is preserved)", () => {
      // SCALE is a module-level const. After inlining times(n), the body `n * SCALE` must
      // still reference SCALE — proving the upvalue is accessible in the inlined copy.
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 100 }), (scale) => {
          const lua = compile(`
              const SCALE = ${scale};
              /** @inline */
              function times(x: number): number { return x * SCALE; }
              declare const n: number;
              const r = times(n);
            `);
          return !lua.includes("times(n)") && lua.includes("SCALE");
        }),
        FC_OPTS,
      );
    }, 20_000);
  });
});
