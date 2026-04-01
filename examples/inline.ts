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

// Pattern: Expression-body inline
const displayHp = lerp(hp, maxHp, t);
const flipped = negate(offset);

// Pattern 1: Void statement site (multi-statement)
/** @inline */
function debugLog(prefix: string, value: number) {
  const msg = `${prefix}: ${value}`;
  // biome-ignore lint/suspicious/noConsole: console.log maps to Lua print in TSTL
  console.log(msg);
}

const playerHp = 75;
debugLog("hp", playerHp);

// Pattern 2: Variable-declaration site (multi-statement with return)
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}

const a = 10;
const r = compute(a);

// Pattern 3: Return site (multi-statement with return)
function caller(): number {
  return compute(a);
}

// Pattern 4: Destructuring site (multi-statement with return)
/** @inline */
function getPos(x: number): { x: number; y: number } {
  const pos = { x: x, y: x + 10 };
  return pos;
}

const { x, y } = getPos(a);

// --- Limitations ---

// Not inlined: no @inline tag
function double(x: number) {
  return x * 2;
}
const doubled = double(hp);

print(displayHp);
print(flipped);
print(doubled);
print(r);
print(x, y);
