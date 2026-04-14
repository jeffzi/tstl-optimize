declare function compute(): number;

// Basic merge — three consecutive pure declarations collapsed into one
function basicMerge(): number {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}

// Mixed run — pure and nil-initializer declarations merged together
function withNil(): number {
  const x = 10;
  let y: number;
  y = x + 1;
  return y;
}

// Limitation: forward reference breaks the run before b
// a and b cannot merge because b's initializer reads a
function forwardRef(): number {
  const a = 1;
  const b = a + 1; // references a — run ends here, a stays separate
  return b;
}

// Limitation: closure upvalue — run ends to avoid nil capture
// The closure would capture a before the multi-assignment binds it
function closureCapture(): () => number {
  const a = 1;
  const f = () => a; // closure captures a — run ends before f
  const b = 2; // b absent from output — dead-local removes it (never used)
  return f;
}

// Limitation: impure initializer — not eligible for merge
function impure(): number {
  const a = 1;
  const b = compute(); // impure — not merged with a
  return a + b;
}

// Limitation: module-scope locals are not merged
const x = 1;
const y = 2;

print(basicMerge());
print(withNil());
print(forwardRef());
print(closureCapture()());
print(impure());
print(x + y);
