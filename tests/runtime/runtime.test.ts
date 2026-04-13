/**
 * Runtime differential tests.
 *
 * Each fixture compiles a self-contained TypeScript source twice — with and without
 * the optimizer plugin — then runs both on every detected Lua runtime and asserts
 * identical stdout output.
 *
 * Tests skip automatically when no Lua runtime is installed. Run `npm run test:runtime`
 * to exercise this suite with the runtime-presence guard enforced.
 */

// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { detectRuntimes, runtimeEqual } from "./helpers";

// ---------------------------------------------------------------------------
// Harness sanity: at least one runtime reachable when tests run via test:runtime
// ---------------------------------------------------------------------------

it("has at least one Lua runtime available", () => {
  const runtimes = detectRuntimes();
  // In test:unit this test is excluded; in test:runtime we want an explicit failure
  // if the machine has no Lua at all rather than a silent no-op.
  expect(runtimes.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Helpers shared across fixtures
// ---------------------------------------------------------------------------

/** Declare print so fixtures can call it without TypeScript errors. */
const PRINT_DECL = "declare function print(s: unknown): void;";

// ---------------------------------------------------------------------------
// inline — 5 fixtures
// ---------------------------------------------------------------------------

describe("inline", () => {
  it("pure inline preserves return value", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      /** @inline */
      function double(x: number): number { return x * 2; }
      print(double(21));
    `);
  });

  it("multi-param inline preserves addition", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      print(add(3, 4) + add(5, 6));
    `);
  });

  it("argument side-effect evaluation order is preserved left to right", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      let order = "";
      function sideA(): number { order = order + "A"; return 1; }
      function sideB(): number { order = order + "B"; return 2; }
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r = add(sideA(), sideB());
      print(r);
      print(order);
    `);
  });

  it("nested inline calls produce the correct result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      /** @inline */
      function double(x: number): number { return x * 2; }
      /** @inline */
      function triple(x: number): number { return x * 3; }
      print(double(triple(2)));
    `);
  });

  it("inline at void site with side-effectful body preserves the call", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      let ran = 0;
      function effect(): number { ran += 1; return ran; }
      /** @inline */
      function callEffect(): number { return effect(); }
      callEffect();
      print(ran);
    `);
  });
});

// ---------------------------------------------------------------------------
// localizer — 3 fixtures
// ---------------------------------------------------------------------------

describe("localizer", () => {
  it("function-scope property chain hoisting preserves access result", () => {
    runtimeEqual(
      `
        ${PRINT_DECL}
        function f(obj: { a: { b: number } }): number {
          return obj.a.b + obj.a.b + obj.a.b;
        }
        print(f({ a: { b: 5 } }));
      `,
      { pluginOptions: { rules: { localizer: { scope: "function", include: ["obj"] } } } },
    );
  });

  it("math.ceil chain hoisting preserves numeric results", () => {
    runtimeEqual(
      `
        ${PRINT_DECL}
        const x = 7.5;
        const a = Math.ceil(x);
        const b = Math.ceil(x + 0.3);
        const c = Math.ceil(x + 0.5);
        print(a + b + c);
      `,
      {
        pluginOptions: { rules: { localizer: { scope: "module" } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );
  });

  it("chain hoisting inside a loop body preserves per-iteration values", () => {
    runtimeEqual(
      `
        ${PRINT_DECL}
        const data = [{ x: 2 }, { x: 3 }, { x: 5 }];
        let sum = 0;
        for (const i of $range(0, data.length - 1)) {
          const item = data[i];
          sum += item.x + item.x;
        }
        print(sum);
      `,
      { pluginOptions: { rules: { localizer: { scope: "function", include: ["item"] } } } },
    );
  });
});

// ---------------------------------------------------------------------------
// dead-local — 3 fixtures
// ---------------------------------------------------------------------------

describe("dead-local", () => {
  it("side-effectful RHS is not dropped when local is unused", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      let ran = 0;
      function doWork(): number { ran += 1; return 99; }
      function f(): void {
        const x = doWork();
      }
      f();
      print(ran);
    `);
  });

  it("pure literal local removal does not affect surrounding code", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      let counter = 0;
      function inc(): void { counter += 1; }
      function f(): void {
        const unused = 42;
        inc();
      }
      f();
      print(counter);
    `);
  });

  it("inline arg temporaries are cleaned up without breaking result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r1 = add(10, 20);
      const r2 = add(30, 40);
      print(r1 + r2);
    `);
  });
});

// ---------------------------------------------------------------------------
// merge-locals — 3 fixtures
// ---------------------------------------------------------------------------

describe("merge-locals", () => {
  it("merged consecutive pure locals produce the correct sum", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      function f(): number {
        const a = 1;
        const b = 2;
        const c = 3;
        return a + b + c;
      }
      print(f());
    `);
  });

  it("closure-captured locals retain correct values after potential merge", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      function makeAdder(n: number): () => number {
        const base = n * 2;
        const offset = 3;
        return () => base + offset;
      }
      const add = makeAdder(5);
      print(add());
    `);
  });

  it("independent pure runs are merged separately without clobbering a call result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      function getValue(): number { return 10; }
      function f(): number {
        const a = 1;
        const b = 2;
        const c = getValue();
        const d = 4;
        const e = 5;
        return a + b + c + d + e;
      }
      print(f());
    `);
  });
});

// ---------------------------------------------------------------------------
// loop-rebase — 5 fixtures
// ---------------------------------------------------------------------------

describe("loop-rebase", () => {
  it("$range(0, length-1) array sum produces correct result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const arr = [10, 20, 30, 40, 50];
      let sum = 0;
      for (const i of $range(0, arr.length - 1)) {
        sum += arr[i];
      }
      print(sum);
    `);
  });

  it("$range array write followed by read produces correct result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const arr = [1, 2, 3, 4, 5];
      for (const i of $range(0, arr.length - 1)) {
        arr[i] = arr[i] * 2;
      }
      let sum = 0;
      for (const i of $range(0, arr.length - 1)) {
        sum += arr[i];
      }
      print(sum);
    `);
  });

  it("dual-array access in the same loop produces correct result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      let dot = 0;
      for (const i of $range(0, a.length - 1)) {
        dot += a[i] * b[i];
      }
      print(dot);
    `);
  });

  it("nested $range loops over a 2D array produce the correct sum", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const matrix = [[1, 2, 3], [4, 5, 6]];
      let sum = 0;
      for (const r of $range(0, matrix.length - 1)) {
        const row = matrix[r];
        for (const c of $range(0, row.length - 1)) {
          sum += row[c];
        }
      }
      print(sum);
    `);
  });

  it("explicit literal limit rebased to correct count", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const arr = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
      let sum = 0;
      for (const i of $range(0, 9)) {
        sum += arr[i];
      }
      print(sum);
    `);
  });
});

// ---------------------------------------------------------------------------
// cross-rule interaction — 1 fixture
// ---------------------------------------------------------------------------

describe("cross-rule: constant-folding + loop-rebase", () => {
  it("constant-folded loop bound combined with rebase produces correct result", () => {
    runtimeEqual(`
      ${PRINT_DECL}
      const N = 5 - 1;
      const arr = [2, 4, 6, 8, 10];
      let sum = 0;
      for (const i of $range(0, N)) {
        sum += arr[i];
      }
      print(sum);
    `);
  });
});
