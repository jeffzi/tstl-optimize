/** @inline */
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** @inline */
const negate = (x: number) => -x;

/** @inline */
function mul(x: number): number {
  return x * x;
}

const hp = 50;
const maxHp = 100;
const t = 0.5;
const offset = 10;

// Pattern: Expression-body inline
const displayHp = lerp(hp, maxHp, t);
const flipped = negate(offset);

// Pattern: Expression-body with complex argument (deep-cloned for each use)
declare const stats: { atk: { base: number } };
const atkSquared = mul(stats.atk.base);

// Void statement site (multi-statement)
/** @inline */
function debugLog(prefix: string, value: number) {
  const msg = `${prefix}: ${value}`;
  // biome-ignore lint/suspicious/noConsole: console.log maps to Lua print in TSTL
  console.log(msg);
}

const playerHp = 75;
debugLog("hp", playerHp);

// Variable-declaration site (multi-statement with return)
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}

const a = 10;
const r = compute(a);

// Return site (multi-statement with return)
function caller(): number {
  return compute(a);
}

// Destructuring site — object (multi-statement with return)
/** @inline */
function getPos(x: number): { x: number; y: number } {
  const pos = { x: x, y: x + 10 };
  return pos;
}

const { x, y } = getPos(a);

// Destructuring site — array (multi-statement with return)
/** @inline */
function getRange(lo: number): [number, number] {
  const hi = lo + 100;
  return [lo, hi];
}

const [lo, hi] = getRange(a);

// Destructuring site — LuaMultiReturn (multi-statement with return)
/** @inline */
function swap(p: number, q: number): LuaMultiReturn<[number, number]> {
  const tmp = p;
  return $multi(q, tmp);
}

const [s1, s2] = swap(hp, maxHp);

// Switch with break in inlined body (break is scoped to switch)
/** @inline */
function classify(n: number): string {
  let label: string;
  switch (n) {
    case 0:
      label = "zero";
      break;
    case 1:
      label = "one";
      break;
    default:
      label = "other";
      break;
  }
  return label;
}

const label = classify(playerHp);

// --- Limitations ---

// Not inlined: no @inline tag
function double(x: number) {
  return x * 2;
}
const doubled = double(hp);

// Not inlined: destructuring parameters are not supported
/** @inline */
function addPair({ a: da, b: db }: { a: number; b: number }) {
  return da + db;
}
const sum = addPair({ a: 1, b: 2 });

print(displayHp);
print(flipped);
print(atkSquared);
print(doubled);
print(r);
print(x, y);
print(lo, hi);
print(s1, s2);
print(label);
print(sum);
