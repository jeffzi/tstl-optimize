const posX = [0, 10, 20];
const velX = [1, 2, 3];
const count = 3;
const dt = 0.5;

// Compound assignment on element access: TSTL caches base/key into temps,
// then loop-rebase makes the cached key pure → unspill folds them away,
// emitting `posX[i] = posX[i] + velX[i] * dt` directly.
for (const i of $range(0, count - 1)) {
  posX[i] += velX[i] * dt;
}

// Postfix increment on element access: same temp pattern → folded.
const counts = [0, 0, 0];
for (const i of $range(0, count - 1)) {
  counts[i]++;
}

// --- Limitations ---

// Not folded: base `obj.arr` is a property read — strict purity declines
// (a property read could fire `__index`). The temps stay.
const obj = { arr: [0, 0, 0] };
for (const i of $range(0, count - 1)) {
  obj.arr[i] += velX[i] * dt;
}

// Not folded: key `f()` is a call — declined under any purity predicate.
function nextIndex(i: number): number {
  return i;
}
const brr = [0, 0, 0];
for (const i of $range(0, count - 1)) {
  brr[nextIndex(i)] += velX[i];
}

print(posX[0], posX[1], posX[2]); // 0.5  11  21.5
print(counts[0], counts[1], counts[2]); // 1  1  1
print(obj.arr[0], obj.arr[1], obj.arr[2]); // 0.5  1  1.5
print(brr[0], brr[1], brr[2]); // 1  2  3
