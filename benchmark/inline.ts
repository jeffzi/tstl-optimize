import { compare_time, render } from "luamark";

const x = 7.3;
const a = 13.7;
const b = 4.2;
const N = 1000;

// --- Baseline functions (no @inline tag) ---
function double_baseline(x: number) {
  return x * 2;
}
function add_baseline(a: number, b: number) {
  return a + b;
}

// --- Optimized functions (@inline tag) ---
/** @inline */
function double_inline(x: number) {
  return x * 2;
}
/** @inline */
function add_inline(a: number, b: number) {
  return a + b;
}

// Simple arithmetic: double(x) → x * 2
print("=== Inline: double(x) ===");
print(
  render(
    compare_time({
      "double(x) [call]": () => {
        for (let i = 0; i < N; i++) {
          double_baseline(x);
        }
      },
      "double(x) [inlined]": () => {
        for (let i = 0; i < N; i++) {
          double_inline(x);
        }
      },
    }),
  ),
);

// Multi-param: add(a, b) → a + b
print("\n=== Inline: add(a, b) ===");
print(
  render(
    compare_time({
      "add(a, b) [call]": () => {
        for (let i = 0; i < N; i++) {
          add_baseline(a, b);
        }
      },
      "add(a, b) [inlined]": () => {
        for (let i = 0; i < N; i++) {
          add_inline(a, b);
        }
      },
    }),
  ),
);
