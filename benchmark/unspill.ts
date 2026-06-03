import { compare_time, render } from "luamark";

const N = 1000;
const DT = 0.016;

const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(1, N)) {
  arr[i - 1] = 0;
  brr[i - 1] = i * 0.5;
}

// Baseline: hand-written pre-unspill Lua — exactly what TSTL emits before unspill folds
// the base/key temps. Loaded via `loadstring` so the plugin cannot rewrite it back.
// Wrapped in a function so the benchmarked call shape mirrors the optimized variant
// (luamark amortizes the single outer call over N inner iterations).
const baselineSrc = `
return function(arr, brr, N, dt)
  for i = 1, N do
    local ____arr_0, ____temp_1 = arr, i
    ____arr_0[____temp_1] = ____arr_0[____temp_1] + brr[i] * dt
  end
end
`;
const [baselineFactory] = loadstring(baselineSrc);
const baselineCompoundAssign = (
  baselineFactory as () => (a: number[], b: number[], n: number, dt: number) => void
)();

// Optimized: same pre-unspill input goes through the plugin and lands as the folded form.
// Wrapped in a `function` to match the baseline call shape.
function optimizedCompoundAssign(a: number[], b: number[], n: number, dt: number): void {
  for (const i of $range(0, n - 1)) {
    a[i] += b[i] * dt;
  }
}

print("=== Unspill: arr[i] += brr[i] * dt in $range loop ===");
print(
  render(
    compare_time({
      "[optimized] arr[i] += brr[i] * dt": () => {
        optimizedCompoundAssign(arr, brr, N, DT);
      },
      "[baseline]  arr[i] += brr[i] * dt": () => {
        baselineCompoundAssign(arr, brr, N, DT);
      },
    }),
  ),
);

// Postfix increment: same temp pattern via a different lowering (value-temp form
// statement-folded to direct assign). Verifies the second matcher.
const counts: number[] = [];
for (const i of $range(1, N)) {
  counts[i - 1] = 0;
}

const baselineIncSrc = `
return function(counts, N)
  for i = 1, N do
    local ____counts_0, ____temp_1 = counts, i
    ____counts_0[____temp_1] = ____counts_0[____temp_1] + 1
  end
end
`;
const [baselineIncFactory] = loadstring(baselineIncSrc);
const baselineIncrement = (baselineIncFactory as () => (c: number[], n: number) => void)();

function optimizedIncrement(c: number[], n: number): void {
  for (const i of $range(0, n - 1)) {
    c[i]++;
  }
}

print("\n=== Unspill: counts[i]++ in $range loop ===");
print(
  render(
    compare_time({
      "[optimized] counts[i]++": () => {
        optimizedIncrement(counts, N);
      },
      "[baseline]  counts[i]++": () => {
        baselineIncrement(counts, N);
      },
    }),
  ),
);
