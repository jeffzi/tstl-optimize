// Number literal — propagated to all read sites
function numberLiteral(): number {
  const x = 42;
  return x;
}

// Negative number literal — wrapped in parentheses to preserve grouping
function negativeLiteral(): number {
  const x = -5;
  return x;
}

// String literal
function stringLiteral(): string {
  const s = "hello";
  return s;
}

// Boolean literal
function booleanLiteral(): boolean {
  const b = true;
  return b;
}

// Multiple read sites — all occurrences replaced
declare function consume(x: number): void;
function multipleReads(): number {
  const x = 10;
  // @ts-expect-error TS6133 — intentionally unused: demonstrates multi-read propagation
  const a = x + 1;
  consume(x);
  return x;
}

// Module-level constant — propagated to subsequent statements
const MODULE_CONST = 42;
export const EXPORTED = MODULE_CONST;

// Chained with constant-folding — propagation feeds folding
function chainedWithFolding(): number {
  const BITS = 24;
  const MASK = 2 ** BITS; // propagated to 2 ** 24, then folded to 16777216
  return MASK;
}

// Limitations

// Reassignment — not propagated (mutable local)
function reassigned(): number {
  let x = 1;
  x = 2;
  return x;
}

// Closure capture — reads inside nested functions are conservatively skipped
function closureCapture(): () => number {
  const x = 10;
  return () => x;
}

// Non-literal initializer — only literal values are propagated
declare function compute(): number;
function nonLiteral(): number {
  const x = compute();
  return x;
}

print(numberLiteral());
print(negativeLiteral());
print(stringLiteral());
print(booleanLiteral());
print(multipleReads());
print(EXPORTED);
print(chainedWithFolding());
print(reassigned());
print(closureCapture()());
print(nonLiteral());
