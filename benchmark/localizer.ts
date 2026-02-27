import { compare_time, render } from "luamark";

const N = 1000;

// Module-level references ensure the localizer sees each chain 2+ times in the AST,
// triggering hoisting. Without these, each chain appears only once (in the loop body)
// and wouldn't meet the default threshold of 2.
const _warmupClock = os.clock();
const _warmupByte = string.byte("A");

// Variable keys prevent the localizer from recognizing the chain: the AST index
// is an Identifier (not a StringLiteral), so luaPropertyChain returns undefined.
const clockKey = "clock";
const byteKey = "byte";

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
