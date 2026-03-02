const posX = [0, 10, 20];
const posY = [0, 5, 15];
const velX = [1, 2, 3];
const velY = [4, 5, 6];
const count = 3;
const dt = 0.5;

// Rebased: every use of i in the body is i + 1 (array indexing)
for (const i of $range(0, count - 1)) {
  posX[i] = posX[i] + velX[i] * dt;
  posY[i] = posY[i] + velY[i] * dt;
}

// --- Limitations ---

// Not rebased: i is used directly (not as i + 1)
const indices: number[] = [];
for (const i of $range(0, count - 1)) {
  indices[i] = i;
}

print(posX[0], posX[1], posX[2]); // 0.5  11  21.5
print(posY[0], posY[1], posY[2]); // 2  7.5  18
print(indices[0], indices[1], indices[2]); // 0  1  2
