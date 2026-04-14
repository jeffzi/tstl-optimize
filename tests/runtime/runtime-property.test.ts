/**
 * Property-based runtime differential tests for optimizer rules.
 *
 * Uses fast-check to generate varied, randomized source fragments and verifies
 * that compiled output produces identical runtime behavior with and without
 * the optimizer plugin.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbIdent, arbSmallArray, arbSmallInt, PRINT_DECL } from "./arbitraries";
import { compileOptimized, type RuntimeEqualOptions, runtimeEqual } from "./helpers";

const FC_OPTS: Parameters<typeof fc.assert>[1] = { numRuns: 10 };

/**
 * Helper to build a sequence of constant declarations.
 * Combines arrays of names and values, padding with default if needed.
 */
function buildConstDecls(names: string[], values: number[], indent: string): string {
  const n = Math.min(names.length, values.length);
  return names
    .slice(0, n)
    .map((name, i) => `const ${name} = ${values[i]};`)
    .join(`\n${indent}`);
}

/**
 * Helper to build localizer plugin options.
 */
function buildLocalizerOpts(scope: "function" | "module", include?: string[]): RuntimeEqualOptions {
  return {
    pluginOptions: {
      rules: {
        localizer: {
          scope,
          ...(include && { include }),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// inline — property-based tests
// ---------------------------------------------------------------------------

describe("inline", () => {
  it("inline generator produces compilable source", () => {
    const source = `
      ${PRINT_DECL}
      /** @inline */
      function f(x: number): number {
        return x + 1;
      }
      print(f(5));
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("varied-arity pure inline preserves arithmetic across multiple call sites", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }), (arg1, arg2) => {
        const source = `
              ${PRINT_DECL}
              /** @inline */
              function f(x: number): number {
                return x * 2;
              }
              print(f(${arg1}) + f(${arg2}));
            `;

        runtimeEqual(source);
      }),
      FC_OPTS,
    );
  });

  it("argument evaluation order is preserved left to right with side effects", () => {
    fc.assert(
      fc.property(arbSmallInt, arbSmallInt, (arg1, arg2) => {
        const source = `
            ${PRINT_DECL}
            let a = 0;
            let b = 0;
            function sideA(): number { a = a + 1; return ${arg1}; }
            function sideB(): number { b = b + 1; return ${arg2}; }
            /** @inline */
            function f(x: number, y: number): number {
              return x + y;
            }
            const result = f(sideA(), sideB());
            print(result);
            print(a);
            print(b);
          `;

        runtimeEqual(source);
      }),
      FC_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// loop-rebase — property-based tests
// ---------------------------------------------------------------------------

describe("loop-rebase", () => {
  it("loop-rebase generator produces compilable source", () => {
    const [arr] = fc.sample(arbSmallArray, 1);
    const source = `
      ${PRINT_DECL}
      const arr = [${arr.join(", ")}];
      let sum = 0;
      for (const i of $range(0, arr.length - 1)) {
        sum += arr[i];
      }
      print(sum);
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("array sum via $range(0, length-1) produces identical result", () => {
    fc.assert(
      fc.property(arbSmallArray, (arr) => {
        const source = `
            ${PRINT_DECL}
            const arr = [${arr.join(", ")}];
            let sum = 0;
            for (const i of $range(0, arr.length - 1)) {
              sum += arr[i];
            }
            print(sum);
          `;

        runtimeEqual(source);
      }),
      FC_OPTS,
    );
  });

  it("write then read via $range produces correct doubled sum", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 8 }),
        (arr) => {
          const source = `
              ${PRINT_DECL}
              const arr = [${arr.join(", ")}];
              for (const i of $range(0, arr.length - 1)) {
                arr[i] = arr[i] * 2;
              }
              let sum = 0;
              for (const i of $range(0, arr.length - 1)) {
                sum += arr[i];
              }
              print(sum);
            `;

          runtimeEqual(source);
        },
      ),
      FC_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// dead-local — property-based tests
// ---------------------------------------------------------------------------

describe("dead-local", () => {
  it("dead-local generator produces compilable source", () => {
    const source = `
      ${PRINT_DECL}
      const unused = 42;
      let counter = 0;
      counter += 1;
      print(counter);
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("pure-literal locals are dropped without breaking surrounding code", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdent, { minLength: 2, maxLength: 6 }),
        fc.array(arbSmallInt, { minLength: 2, maxLength: 6 }),
        (localVars, literals) => {
          const localDecls = buildConstDecls(localVars, literals, "            ");

          const source = `
            ${PRINT_DECL}
            let counter = 0;
            ${localDecls}
            counter += 1;
            print(counter);
          `;

          runtimeEqual(source);
        },
      ),
      FC_OPTS,
    );
  });

  it("side-effectful locals are preserved", () => {
    fc.assert(
      fc.property(arbSmallInt, (callResult) => {
        const source = `
          ${PRINT_DECL}
          let counter = 0;
          function doWork(): number {
            counter = counter + 1;
            return ${callResult};
          }
          const result = doWork();
          print(counter);
        `;

        runtimeEqual(source);
      }),
      FC_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// merge-locals — property-based tests
// ---------------------------------------------------------------------------

describe("merge-locals", () => {
  it("merge-locals generator produces compilable source", () => {
    const source = `
      ${PRINT_DECL}
      const a = 1;
      const b = 2;
      print(a + b);
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("consecutive pure locals sum correctly", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdent, { minLength: 2, maxLength: 5 }),
        fc.array(arbSmallInt, { minLength: 2, maxLength: 5 }),
        (localVars, values) => {
          const n = Math.min(localVars.length, values.length);
          const localDecls = buildConstDecls(localVars.slice(0, n), values, "            ");
          const sumExpr = localVars.slice(0, n).join(" + ");

          const source = `
            ${PRINT_DECL}
            ${localDecls}
            print(${sumExpr});
          `;

          runtimeEqual(source);
        },
      ),
      FC_OPTS,
    );
  });

  it("impure-RHS local stops merge and is preserved", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdent, { minLength: 3, maxLength: 5 }),
        fc.array(arbSmallInt, { minLength: 1, maxLength: 4 }),
        arbSmallInt,
        (allVars, pureValues, callResult) => {
          const midIdx = Math.floor(allVars.length / 2);
          const vars1 = allVars.slice(0, midIdx);
          const varMid = allVars[midIdx];
          const vars2 = allVars.slice(midIdx + 1);
          const val = (i: number) => pureValues[i % pureValues.length] ?? 0;

          const decls1 = buildConstDecls(
            vars1,
            vars1.map((_, i) => val(i)),
            "            ",
          );
          const declMid = `const ${varMid} = getValue();`;
          const decls2 = buildConstDecls(
            vars2,
            vars2.map((_, i) => val(vars1.length + i)),
            "            ",
          );

          const sumExpr = [...vars1, varMid, ...vars2].join(" + ");

          const source = `
            ${PRINT_DECL}
            let callCount = 0;
            function getValue(): number {
              callCount = callCount + 1;
              return ${callResult};
            }
            ${decls1}
            ${declMid}
            ${decls2}
            print(${sumExpr});
            print(callCount);
          `;

          runtimeEqual(source);
        },
      ),
      FC_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// conditional-compilation — property-based tests
// ---------------------------------------------------------------------------

describe("conditional-compilation", () => {
  it("conditional-compilation generator produces compilable source", () => {
    const source = `
      ${PRINT_DECL}
      declare const DEBUG: boolean;
      let x = 0;
      if (DEBUG) {
        x = 1;
      } else {
        x = 2;
      }
      print(x);
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("if/else strips correct branch based on compile-time constants", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdent, { minLength: 2, maxLength: 3 }),
        fc.array(arbSmallInt, { minLength: 3, maxLength: 3 }),
        (constBaseNames, branchValues) => {
          const constantNames = constBaseNames.map((n) => `CC_${n}`);
          const constDecls = constantNames
            .map((name) => `declare const ${name}: boolean;`)
            .join("\n            ");

          const ifBranches = constantNames
            .slice(0, -1)
            .map(
              (name, i) => `${i === 0 ? "if" : "else if"} (${name}) {
              x = ${branchValues[i]};
            }`,
            )
            .join(" ");

          const ifChain = `${ifBranches} else {
              x = ${branchValues[constantNames.length - 1]};
            }`;

          const source = `
            ${PRINT_DECL}
            ${constDecls}
            let x = 0;
            ${ifChain}
            print(x);
          `;

          const constants = Object.fromEntries(
            constantNames.map((name) => [name, { env: "", default: false }]),
          );

          runtimeEqual(source, {
            pluginOptions: {
              rules: { "conditional-compilation": { constants } },
            },
          });
        },
      ),
      FC_OPTS,
    );
  });

  it("side effects in surviving branch are preserved", () => {
    fc.assert(
      fc.property(arbSmallInt, (counterIncrement) => {
        const source = `
          ${PRINT_DECL}
          declare const DEBUG: boolean;
          let counter = 0;
          if (DEBUG) {
            counter = counter + 1;
          } else {
            counter = counter + ${counterIncrement};
          }
          print(counter);
        `;

        const ccOpts = {
          pluginOptions: {
            rules: {
              "conditional-compilation": {
                constants: {
                  DEBUG: { env: "", default: false },
                },
              },
            },
          },
        };

        runtimeEqual(source, ccOpts);
      }),
      FC_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// localizer — property-based tests
// ---------------------------------------------------------------------------

describe("localizer", () => {
  it("localizer generator produces compilable source", () => {
    const source = `
      ${PRINT_DECL}
      const obj = { a: { b: 5 } };
      let sum = 0;
      sum += obj.a.b;
      sum += obj.a.b;
      print(sum);
    `;
    expect(compileOptimized(source).length).toBeGreaterThan(0);
  });

  it("function-scope chain hoisting preserves access result", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(arbSmallInt, { minLength: 2, maxLength: 5 }),
        (numAccesses, values) => {
          const accesses = Array(numAccesses)
            .fill(0)
            .map(() => "sum += obj.a.b;")
            .join("\n            ");

          const source = `
            ${PRINT_DECL}
            function process(obj: { a: { b: number } }): number {
              let sum = 0;
              ${accesses}
              return sum;
            }
            print(process({ a: { b: ${values[0]} } }));
          `;

          runtimeEqual(source, buildLocalizerOpts("function", ["obj"]));
        },
      ),
      FC_OPTS,
    );
  });

  it("math stdlib hoisting preserves numeric results", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(arbSmallInt, { minLength: 2, maxLength: 4 }),
        (numCalls, values) => {
          const mathCalls = Array(numCalls)
            .fill(0)
            .map((_, i) => `sum += Math.floor(${values[i] || 5} + 0.5);`)
            .join("\n            ");

          const source = `
            ${PRINT_DECL}
            let sum = 0;
            ${mathCalls}
            print(sum);
          `;

          runtimeEqual(source, buildLocalizerOpts("module"));
        },
      ),
      FC_OPTS,
    );
  });
});
