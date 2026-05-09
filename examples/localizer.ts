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

// config.physics.friction accessed 2x in loop → hoisted to a local above
// the loop. velX[i] and velY[i] read and written multiple times → cached
// in locals within the loop body, written back at end of each iteration.
for (const i of $range(0, count - 1)) {
  velX[i] = velX[i] * config.physics.friction;
  velY[i] = velY[i] + config.physics.gravity * dt;
  velY[i] = velY[i] * config.physics.friction;
  posX[i] = posX[i] + velX[i] * dt;
  posY[i] = posY[i] + velY[i] * dt;
}

// config.physics.gravity accessed only 1x per scope → not hoisted
const terminalSpeed = config.physics.gravity / config.physics.friction;

// --- Limitations ---

// Not localized: applyDrag() mutates the drag array between reads — caching
// drag[i] in a local would miss the write from the function call
const drag = [1.0, 0.9];
function applyDrag(i: number): void {
  drag[i] = drag[i] * 0.5;
}
for (const i of $range(0, count - 1)) {
  drag[i] = drag[i] * config.physics.friction;
  applyDrag(i);
}

print(posX[0], posY[0]); // 0.49  2.401
print(terminalSpeed); // 10
print(drag[0], drag[1]); // 0.49  0.441
