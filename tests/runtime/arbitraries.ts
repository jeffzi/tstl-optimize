/**
 * Runtime-specific source-fragment generators for property-based testing.
 *
 * Exports arbitraries for generating TypeScript source code that is safe to
 * compile and execute. All generated source produces syntactically valid,
 * determinate output across Lua runtimes.
 */

import fc from "fast-check";

// ---------------------------------------------------------------------------
// Shared declaration and constants
// ---------------------------------------------------------------------------

/** TypeScript declaration to enable print() calls without compiler errors. */
export const PRINT_DECL = "declare function print(s: unknown): void;";

// ---------------------------------------------------------------------------
// Safe identifiers
// ---------------------------------------------------------------------------

/** TypeScript keywords and reserved identifiers that must be avoided in source generation. */
const RESERVED_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "let",
  "const",
  "return",
  "while",
  "do",
  "function",
  "class",
  "new",
  "this",
  "true",
  "false",
  "null",
  "void",
  "type",
  "in",
  "of",
]);

/** Lowercase letters used in identifier generation. */
const LOWERCASE_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/** Lowercase letters and digits used in identifier continuation. */
const IDENTIFIER_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/**
 * Arbitrary that generates valid TypeScript identifiers: lowercase letter
 * followed by 0–4 lowercase letters or digits, filtered against reserved
 * keywords.
 */
export const arbIdent: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...LOWERCASE_LETTERS),
    fc.array(fc.constantFrom(...IDENTIFIER_CHARS), { minLength: 0, maxLength: 4 }),
  )
  .map(([first, rest]) => first + rest.join(""))
  .filter((s) => !RESERVED_KEYWORDS.has(s));

// ---------------------------------------------------------------------------
// Numeric types
// ---------------------------------------------------------------------------

/**
 * Arbitrary for small integers in the range [-20, 20].
 * Useful for avoiding overflow and maintaining readability in generated code.
 */
export const arbSmallInt: fc.Arbitrary<number> = fc.integer({ min: -20, max: 20 });

/**
 * Arbitrary for small integer arrays (length 1–8, values -20 to 20).
 * Ideal for loop and array indexing tests.
 */
export const arbSmallArray: fc.Arbitrary<number[]> = fc.array(fc.integer({ min: -20, max: 20 }), {
  minLength: 1,
  maxLength: 8,
});

// ---------------------------------------------------------------------------
// Arithmetic expression generator
