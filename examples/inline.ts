/** @inline */
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** @inline */
const negate = (x: number) => -x;

const hp = 50;
const maxHp = 100;
const t = 0.5;
const offset = 10;

const displayHp = lerp(hp, maxHp, t);
const flipped = negate(offset);

// --- Limitations ---

// Not inlined: no @inline tag
function double(x: number) {
  return x * 2;
}
const doubled = double(hp);

// Not inlined: multi-statement body (emits warning at compile time)
/** @inline */
function clampedAdd(a: number, b: number) {
  const sum = a + b;
  return sum > 100 ? 100 : sum;
}
const total = clampedAdd(hp, 30);

print(displayHp); // 75
print(flipped); // -10
print(doubled); // 100
print(total); // 80
