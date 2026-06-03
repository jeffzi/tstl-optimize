import { compare_time, render } from "luamark";

const N = 1000;

// Baseline arms use function parameters to prevent propagation — the rule only
// targets const locals with literal initializers, not parameters.

// --- Simple propagation: single read site ---

function simple_baseline(val: number) {
  return val;
}

function simple_optimized() {
  const val = 42;
  return val;
}

print("=== Simple propagation: const x = 42; return x ===");
let _simple_acc = 0;
print(
  render(
    compare_time({
      "[baseline]  return param": () => {
        for (let i = 0; i < N; i++) {
          _simple_acc += simple_baseline(42);
        }
      },
      "[optimized] return const": () => {
        for (let i = 0; i < N; i++) {
          _simple_acc += simple_optimized();
        }
      },
    }),
  ),
);

// --- Multiple reads: const used in several expressions ---

function multi_baseline(val: number) {
  return val + val * 2 + val * 3;
}

function multi_optimized() {
  const val = 7;
  return val + val * 2 + val * 3;
}

print("\n=== Multiple reads: val + val * 2 + val * 3 ===");
let _multi_acc = 0;
print(
  render(
    compare_time({
      "[baseline]  param reads": () => {
        for (let i = 0; i < N; i++) {
          _multi_acc += multi_baseline(7);
        }
      },
      "[optimized] const reads": () => {
        for (let i = 0; i < N; i++) {
          _multi_acc += multi_optimized();
        }
      },
    }),
  ),
);

// --- Propagation + folding cascade ---
// Propagation substitutes BITS → 24, then constant-folding collapses 2 ** 24 → 16777216.
// The baseline uses a parameter, so the exponentiation runs at runtime each iteration.

function cascade_baseline(bits: number) {
  return 2 ** bits;
}

function cascade_optimized() {
  const BITS = 24;
  return 2 ** BITS;
}

print("\n=== Cascade: propagation feeds constant-folding (2 ** BITS) ===");
let _cascade_acc = 0;
print(
  render(
    compare_time({
      "[baseline]  2 ** param": () => {
        for (let i = 0; i < N; i++) {
          _cascade_acc += cascade_baseline(24);
        }
      },
      "[optimized] 2 ** const": () => {
        for (let i = 0; i < N; i++) {
          _cascade_acc += cascade_optimized();
        }
      },
    }),
  ),
);
