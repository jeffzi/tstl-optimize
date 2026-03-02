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

// x ** 2 is expanded to x * x (avoids ^ dispatch), but higher exponents fall
// through to Lua's ^ operator since the expansion grows combinatorially
const cubed = x ** 3;

// Math.max/min replaced with (a > b) and a or b, which only works for 2 args
const biggest = Math.max(x, y, speed);

print(dist); // 201.24611797498
print(tileX, tileY); // 0  0
print(absX, absY); // 90  180
print(clamped, bounded); // 5  5
print(cubed); // 1000
print(biggest); // 20
