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
let _double_acc = 0;
print(
  render(
    compare_time({
      "[baseline]  double(x)": () => {
        for (let i = 0; i < N; i++) {
          _double_acc += double_baseline(x);
        }
      },
      "[optimized] double(x)": () => {
        for (let i = 0; i < N; i++) {
          _double_acc += double_inline(x);
        }
      },
    }),
  ),
);

// Multi-param: add(a, b) → a + b
print("\n=== Inline: add(a, b) ===");
let _add_acc = 0;
print(
  render(
    compare_time({
      "[baseline]  add(a, b)": () => {
        for (let i = 0; i < N; i++) {
          _add_acc += add_baseline(a, b);
        }
      },
      "[optimized] add(a, b)": () => {
        for (let i = 0; i < N; i++) {
          _add_acc += add_inline(a, b);
        }
      },
    }),
  ),
);
