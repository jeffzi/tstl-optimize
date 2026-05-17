import { compare_time, render } from "luamark";

const N = 1000;

// Module-level references ensure the localizer sees each chain 2+ times in the AST,
// triggering hoisting. Without these, each chain appears only once (in the loop body)
// and wouldn't meet the default threshold of 2.
const _warmupClock = os.clock();
const _warmupByte = string.byte("A");

// Nested table simulates a multi-level namespace (common in game engines).
// Non-stdlib roots are only hoisted at function scope (lenient filter), so the
// callback body needs 2+ occurrences to meet the threshold independently.
const app = { physics: { gravity: 9.81 } };

// Variable keys prevent the localizer from recognizing the chain: the AST index
// is an Identifier (not a StringLiteral), so luaPropertyChain returns undefined.
const clockKey = "clock";
const byteKey = "byte";
const physicsKey = "physics";

// os.clock: global table access (common in Lua game loops)
// Baseline forces dynamic access via variable key to block localizer hoisting.
// Optimized uses static property access which the localizer hoists to a local.
print("=== os.clock: global chain vs localizer-hoisted local ===");
print(
  render(
    compare_time({
      "os[key]() (baseline)": {
        fn: () => {
          for (let i = 0; i < N; i++) {
            (os as unknown as Record<string, () => number>)[clockKey]();
          }
        },
        baseline: true,
      },
      "os.clock() [localizer hoists]": () => {
        for (let i = 0; i < N; i++) {
          os.clock();
        }
      },
    }),
  ),
);

// string.byte: another common global chain
print("\n=== string.byte: global chain vs localizer-hoisted local ===");
print(
  render(
    compare_time({
      'string[key]("A") (baseline)': {
        fn: () => {
          for (let i = 0; i < N; i++) {
            (string as unknown as Record<string, (s: string) => number>)[byteKey]("A");
          }
        },
        baseline: true,
      },
      'string.byte("A") [localizer hoists]': () => {
        for (let i = 0; i < N; i++) {
          string.byte("A");
        }
      },
    }),
  ),
);

// Deeper chain (3 levels): each extra level is an extra table lookup saved.
// Demonstrates proportionally larger wins with deeper nesting.
print("\n=== app.physics.gravity: 3-level chain vs localizer-hoisted local ===");
let deepAcc = 0;
print(
  render(
    compare_time({
      "app[key].gravity (baseline)": {
        fn: () => {
          let sum = (app as unknown as Record<string, { gravity: number }>)[physicsKey].gravity;
          for (let i = 0; i < N; i++) {
            sum += (app as unknown as Record<string, { gravity: number }>)[physicsKey].gravity;
          }
          deepAcc += sum;
        },
        baseline: true,
      },
      "app.physics.gravity [localizer hoists]": () => {
        let sum = app.physics.gravity;
        for (let i = 0; i < N; i++) {
          sum += app.physics.gravity;
        }
        deepAcc += sum;
      },
    }),
  ),
);
print(deepAcc);
