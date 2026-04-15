// Arithmetic — folded to a single literal
const a = 1 + 2 * 3;
const b = 10 / 2 - 1;
const c = 2 ** 8; // 256
const d = 17 % 5; // 2

// Comparison — folded to boolean
// Cast to number to avoid TypeScript's "no overlap" error on literal comparison
const eq = (10 as number) === 10; // true
const ne = (1 as number) !== 2; // true
const lt = (3 as number) < 5; // true

// Logical — folded through and/or/not
const t = true && true; // true
const f = true && false; // false
const n = !true; // false
const o = false || true; // true

// String concatenation
const greeting = "hello" + " " + "world";

// Multi-pass — nested expressions resolved over multiple passes
const nested = (1 + 2) * (3 + 4); // 21
const chain = 1 + 2 + 3 + 4; // 10

// Limitations

// Non-finite: 1 / 0 is Infinity in Lua, which has no literal — not folded
declare const x: number;
const inf = 1 / 0;

// Side effects: expressions involving calls are not folded
declare function getValue(): number;
const runtime = getValue() + 1;

// Mixed: one constant operand does not fold the whole expression
const mixed = x + 1;

print(a, b, c, d);
print(eq, ne, lt);
print(t, f, n, o);
print(greeting);
print(nested, chain);
print(inf);
print(runtime);
print(mixed);
