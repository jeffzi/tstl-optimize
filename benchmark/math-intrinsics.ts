import { compare_time, render } from "luamark";

const x = 7.3;
const a = 13.7;
const b = 4.2;
const N = 1000;

// Math.floor: math.floor(x) vs x - x % 1 (plugin output)
print("=== Math.floor ===");
print(
  render(
    compare_time({
      "math.floor(x)": () => {
        for (let i = 0; i < N; i++) {
          math.floor(x);
        }
      },
      "Math.floor(x) [optimized]": () => {
        for (let i = 0; i < N; i++) {
          Math.floor(x);
        }
      },
    }),
  ),
);

// Math.sqrt: math.sqrt(x) vs x ^ 0.5 (plugin output)
print("\n=== Math.sqrt ===");
print(
  render(
    compare_time({
      "math.sqrt(x)": () => {
        for (let i = 0; i < N; i++) {
          math.sqrt(x);
        }
      },
      "Math.sqrt(x) [optimized]": () => {
        for (let i = 0; i < N; i++) {
          Math.sqrt(x);
        }
      },
    }),
  ),
);

// Math.abs: math.abs(x) vs (x < 0) and -x or x (plugin output)
print("\n=== Math.abs ===");
print(
  render(
    compare_time({
      "math.abs(x)": () => {
        for (let i = 0; i < N; i++) {
          math.abs(x);
        }
      },
      "Math.abs(x) [optimized]": () => {
        for (let i = 0; i < N; i++) {
          Math.abs(x);
        }
      },
    }),
  ),
);

// Math.max: math.max(a, b) vs (a > b) and a or b (plugin output)
print("\n=== Math.max ===");
print(
  render(
    compare_time({
      "math.max(a, b)": () => {
        for (let i = 0; i < N; i++) {
          math.max(a, b);
        }
      },
      "Math.max(a, b) [optimized]": () => {
        for (let i = 0; i < N; i++) {
          Math.max(a, b);
        }
      },
    }),
  ),
);

// Math.min: math.min(a, b) vs (a < b) and a or b (plugin output)
print("\n=== Math.min ===");
print(
  render(
    compare_time({
      "math.min(a, b)": () => {
        for (let i = 0; i < N; i++) {
          math.min(a, b);
        }
      },
      "Math.min(a, b) [optimized]": () => {
        for (let i = 0; i < N; i++) {
          Math.min(a, b);
        }
      },
    }),
  ),
);

// x ** 2 vs x * x (plugin output)
const two = 2; // variable exponent prevents plugin optimization
print("\n=== x ** 2 vs x * x ===");
print(
  render(
    compare_time({
      "x ^ 2": () => {
        for (let i = 0; i < N; i++) {
          x ** two; // variable exponent → x ^ two (not optimized)
        }
      },
      "x ** 2 [optimized]": () => {
        for (let i = 0; i < N; i++) {
          x ** 2; // literal 2 → x * x (optimized)
        }
      },
    }),
  ),
);
