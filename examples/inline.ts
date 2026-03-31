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

// Multi-statement inline at statement site -- expanded into do...end block
/** @inline */
function debugLog(prefix: string, value: number) {
  const msg = prefix + ": " + value;
  console.log(msg);
}

const playerHp = 75;
debugLog("hp", playerHp);

print(displayHp); // 75
print(flipped); // -10
print(doubled); // 100
