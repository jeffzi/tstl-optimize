declare function doSomething(): void;
declare const x: boolean;
declare const y: boolean;

// Fully empty chain with pure conditions — entire if removed
// biome-ignore lint/correctness/noConstantCondition: intentional example input for the optimizer
if (true) {
}

// Else promotion — empty if-block with non-empty else:
// condition negated, else body promoted, else clause dropped
if (x) {
} else {
  doSomething();
}

// Trailing empty branches pruned — non-empty leading branch kept,
// empty elseif and else removed
if (y) {
  doSomething();
  // biome-ignore lint/correctness/noConstantCondition: intentional example input for the optimizer
} else if (false) {
} else {
}

// Limitation: condition with side effects — if not removed
declare function sideEffect(): boolean;
if (sideEffect()) {
}

// Limitation: non-empty if-block with non-empty else — nothing to promote
if (x) {
  doSomething();
} else {
  doSomething();
}
