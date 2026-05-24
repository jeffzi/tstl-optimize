const x = 10;
const y = 20;
const targetX = 100;
const targetY = 200;
const speed = 5;
const maxSpeed = 10;

// Distance to target
const dx = targetX - x;
const dy = targetY - y;
const dist = Math.sqrt(dx ** 2 + dy ** 2);

// Snap to 32px tile grid
const tileX = Math.floor(x / 32);
const tileY = Math.floor(y / 32);

// Absolute offset for bounds check
const absX = Math.abs(dx);
const absY = Math.abs(dy);

// Clamp speed
const clamped = Math.min(speed, maxSpeed);
const bounded = Math.max(0, speed);

// --- Limitations ---

// x ** 2 → x * x, x ** 3 → (x * x) * x on all targets.
// x ** 4 → (x * x) * (x * x) on LuaJIT only; PUC keeps ^ (C pow is faster).
// Higher exponents fall through to Lua's ^ operator.
const cubed = x ** 3;

// Math.max/min is rewritten to (a > b) and a or b only when both args are
// numeric literals. Non-literal operands are left as-is: Lua __le/__lt
// metamethods could have side effects, making the short-circuit rewrite unsafe.
const maxLit = Math.max(2, 3);
const minLit = Math.min(1, 2);

// Not rewritten: 3+ arguments or non-literal operands fall through to
// math.max/math.min — the short-circuit pattern only handles 2 literal args
const biggest = Math.max(x, y, speed);

print(dist); // 201.24611797498
print(tileX, tileY); // 0  0
print(absX, absY); // 90  180
print(clamped, bounded); // 5  5
print(maxLit, minLit); // 3  1
print(cubed); // 1000
print(biggest); // 20
