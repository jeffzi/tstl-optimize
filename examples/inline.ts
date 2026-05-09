/** @inline */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** @inline */
const negate = (x: number): number => -x;

/** @inline */
function mul(x: number): number {
  return x * x;
}

const hp = 50;
const maxHp = 100;
const t = 0.5;
const offset = 10;

// Single-expression body: call replaced by the body expression with
// arguments substituted inline
const displayHp = lerp(hp, maxHp, t);
const flipped = negate(offset);

// Not inlined: argument used multiple times in body (`x * x`) and property
// access (`stats.atk.base`) may have side effects — duplicating it could
// change observable behavior.
const stats = { atk: { base: 100 } };
const atkSquared = mul(stats.atk.base);

// Multi-statement body at void call site: body spliced into a do...end
// block with arguments bound to temporaries
/** @inline */
function debugLog(prefix: string, value: number): void {
  const msg = `${prefix}: ${value}`;
  print(msg);
}

const playerHp = 75;
debugLog("hp", playerHp);

// Multi-statement body at variable declaration: body spliced into do...end,
// return value assigned to the declared variable
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}

const a = 10;
const r = compute(a);

// Multi-statement body at return site: body spliced directly without a
// do...end wrapper, last expression returned
function caller(): number {
  return compute(a);
}

// Object destructuring: body spliced into do...end, return value stored in
// a temp, then fields destructured from it
/** @inline */
function getPos(x: number): { x: number; y: number } {
  const pos = { x: x, y: x + 10 };
  return pos;
}

const { x, y } = getPos(a);

// Array destructuring: body spliced into do...end, return value stored in
// a temp, then unpacked into the binding variables
/** @inline */
function getRange(lo: number): [number, number] {
  const hi = lo + 100;
  return [lo, hi];
}

const [lo, hi] = getRange(a);

// LuaMultiReturn destructuring: body spliced into do...end, each return
// position stored in a separate temp, then assigned to binding variables
/** @inline */
function swap(p: number, q: number): LuaMultiReturn<[number, number]> {
  const tmp = p;
  return $multi(q, tmp);
}

const [s1, s2] = swap(hp, maxHp);

// Switch in inlined body: break statements are safe because they are scoped
// to the switch, not the inlined block
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
function double(x: number): number {
  return x * 2;
}
const doubled = double(hp);

// Not inlined: destructuring parameters are not supported — the plugin
// cannot reliably map destructured bindings to argument positions
/** @inline */
function addPair({ a: da, b: db }: { a: number; b: number }): number {
  return da + db;
}
const sum = addPair({ a: 1, b: 2 });

print(displayHp);
print(flipped);
print(atkSquared);
print(doubled);
print(r);
print(caller());
print(x, y);
print(lo, hi);
print(s1, s2);
print(label);
print(sum);
