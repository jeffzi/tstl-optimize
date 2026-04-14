const config = {
  physics: {
    gravity: 9.8,
    friction: 0.98,
  },
};
const posX = [0, 10];
const posY = [0, 5];
const velX = [1, 2];
const velY = [0, 0];
const count = 2;
const dt = 0.5;

// config.physics.friction (3×) and config.physics.gravity (2×) are hoisted to
// loop-scope locals by the localizer rule. Requires "include": ["config"] in
// localizer.opts.json — non-stdlib roots are opt-in to prevent unintended
// snapshotting of mutable globals.
for (const i of $range(0, count - 1)) {
  velX[i] = velX[i] * config.physics.friction;
  velY[i] = velY[i] + config.physics.gravity * dt;
  velY[i] = velY[i] * config.physics.friction;
  posX[i] = posX[i] + velX[i] * dt;
  posY[i] = posY[i] + velY[i] * dt;
}

const terminalSpeed = config.physics.gravity / config.physics.friction;

// --- Limitations ---

// Array elements not localized: applyDrag mutates the drag array, so caching
// drag[i] in a local would miss the side-effect
const drag = [1.0, 0.9];
function applyDrag(i: number) {
  drag[i] = drag[i] * 0.5;
}
for (const i of $range(0, count - 1)) {
  drag[i] = drag[i] * config.physics.friction;
  applyDrag(i);
}

print(posX[0], posY[0]); // 0.49  2.401
print(terminalSpeed); // 10
print(drag[0], drag[1]); // 0.49  0.441
