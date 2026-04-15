declare function compute(): number;
declare function log(x: number): void;

// Pure unused local — removed (never read, pure initializer)
function pureUnused(): number {
  const dead = 42;
  const live = 10;
  return live;
}

// Used local — kept
function usedLocal(): number {
  const x = 5;
  return x * 2;
}

// Closure capture — local read by nested function, kept
function captureExample(): () => number {
  const base = 100;
  return () => base + 1;
}

// Limitation: impure initializer — call must execute even though result is unused
function impureUnused(): number {
  const unused = compute(); // compute() has side effects, declaration preserved
  return 0;
}

// Limitation: module-scope locals are not removed (only function-scope)
const moduleLevel = 99; // not touched — module scope

// Limitation: multi-variable declaration — skipped entirely
// TSTL compiles LuaMultiReturn destructuring to `local p, q = swap()`
declare function swap(): LuaMultiReturn<[number, number]>;
function multiVar(): void {
  const [p, q] = swap(); // emits `local p, q = swap()` — multi-var, not eligible
  log(p + q);
}

print(pureUnused());
print(usedLocal());
print(captureExample()());
print(impureUnused());
print(moduleLevel);
multiVar();
