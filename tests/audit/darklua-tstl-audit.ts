/**
 * Disposable TSTL behavior audit script for darklua candidate rules.
 * Run: npx tsx tests/audit/darklua-tstl-audit.ts
 * Delete after use.
 */

import { compile } from "../helpers";

function probe(label: string, source: string, disableAllRules = false): void {
  const pluginOptions = disableAllRules
    ? {
        rules: {
          "conditional-compilation": { enabled: false },
          "math-intrinsics": { enabled: false },
          "loop-rebase": { enabled: false },
          inline: { enabled: false },
          localizer: { enabled: false },
          "debug-strip": { enabled: false },
        },
      }
    : undefined;
  console.log(`\n--- ${label} ---`);
  try {
    const lua = compile(source, { pluginOptions });
    console.log(lua.trim());
  } catch (e) {
    console.log(`COMPILE ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ============================================================
// SECTION 1: nil-elision
// ============================================================
console.log("\n=== 1. nil-elision (remove_nil_declaration) ===");

probe("1a: uninitialized let (no plugin rules)", "let x: number;", true);

probe(
  "1b: uninitialized let then assigned (no plugin rules)",
  `let y: number;
y = 5;`,
  true,
);

probe(
  "1c: destructuring with fewer values (no plugin rules)",
  "const [a, b] = [1] as [number, number?];",
  true,
);

probe(
  "1d: optional function parameter default (no plugin rules)",
  "function f(x?: number): number { return x ?? 0; }",
  true,
);

// ============================================================
// SECTION 2: dead-local
// ============================================================
console.log("\n=== 2. dead-local (remove_unused_variable) ===");

probe("2a: const declared and never read (no plugin rules)", "const unused = 42;", true);

probe(
  "2b: const used only once (no plugin rules)",
  `const used = 42;
console.log(used);`,
  true,
);

probe(
  "2c: after @inline fires — orphaned local",
  `/** @inline */ function add(a: number, b: number): number { return a + b; }
const result = add(1, 2);`,
  false,
);

probe(
  "2d: unused destructuring member (no plugin rules)",
  `const [first, _second] = [1, 2] as [number, number];
console.log(first);`,
  true,
);

// ============================================================
// SECTION 3: const-fold
// ============================================================
console.log("\n=== 3. const-fold (compute_expression) ===");

probe("3a: simple arithmetic constant (no plugin rules)", "const c = 2 * 3 + 1;", true);

probe("3b: string concatenation constant (no plugin rules)", `const s = "foo" + "bar";`, true);

probe("3c: boolean constant (no plugin rules)", "const t = !false;", true);

probe("3d: arithmetic with all plugin rules active", "const c = 2 * 3 + 1;", false);

probe("3e: template literal (no plugin rules)", `const msg = \`hello ${"world"}\`;`, true);

// ============================================================
// SECTION 4: remove_empty_do
// ============================================================
console.log("\n=== 4. remove_empty_do ===");

probe(
  "4a: empty if branch — conditional-compilation strips content",
  `declare const DEBUG: boolean;
if (DEBUG) { }`,
  false,
);

probe(
  "4b: if with false constant (conditional-compilation active)",
  `declare const PROD: boolean;
if (!PROD) { console.log("debug only"); }`,
  false,
);

probe(
  "4c: @inline void empty body function",
  `/** @inline */ function noop(): void {}
noop();`,
  false,
);

probe(
  "4d: plain empty if block (no plugin rules)",
  `const x = 1;
if (x > 0) {}
const y = 2;`,
  true,
);

// ============================================================
// SECTION 5: dead-code (filter_after_early_return)
// ============================================================
console.log("\n=== 5. dead-code (filter_after_early_return) ===");

probe(
  "5a: return inside if block (conditional-compilation may fire)",
  `function f(): number {
  if (true) {
    return 1;
  }
  return 2;
}`,
  false,
);

probe(
  "5b: direct early return then dead statements (no plugin rules)",
  `function g(): void {
  return;
  console.log("dead");
}`,
  true,
);

probe(
  "5c: return inside if — no plugin rules",
  `function f(): number {
  if (true) {
    return 1;
  }
  return 2;
}`,
  true,
);

probe(
  "5d: conditional-compilation on if-true branch",
  `declare const FLAG: boolean;
function h(): number {
  if (FLAG) {
    return 99;
  }
  return 0;
}`,
  false,
);

// ============================================================
// SECTION 6: merge-locals
// ============================================================
console.log("\n=== 6. merge-locals (group_local_assignment) ===");

probe(
  "6a: two consecutive const declarations (no plugin rules)",
  `const p = 1;
const q = 2;`,
  true,
);

probe(
  "6b: const inside function (no plugin rules)",
  `function h() {
  const r = 3;
  const s = 4;
  return r + s;
}`,
  true,
);

probe(
  "6c: three consecutive consts (no plugin rules)",
  `const a = 1;
const b = 2;
const c = 3;
console.log(a + b + c);`,
  true,
);

// ============================================================
// SECTION 7: convert_index_to_field
// ============================================================
console.log("\n=== 7. convert_index_to_field ===");

probe(
  "7a: dot notation property access (no plugin rules)",
  `const obj = { key: 1 };
const v1 = obj.key;`,
  true,
);

probe(
  "7b: bracket notation with string literal (no plugin rules)",
  `const obj = { key: 1 };
const v2 = (obj as any)["key"];`,
  true,
);

probe(
  "7c: method call via dot notation (no plugin rules)",
  `const arr = [1, 2, 3];
arr.push(4);`,
  true,
);

probe(
  "7d: dynamic bracket access (no plugin rules)",
  `const obj: Record<string, number> = {};
const key = "x";
const v = obj[key];`,
  true,
);

probe(
  "7e: numeric index access (no plugin rules)",
  `const arr = [1, 2, 3];
const v = arr[0];`,
  true,
);

// ============================================================
// SECTION 8: debug-strip assert extension
// ============================================================
console.log("\n=== 8. debug-strip assert extension ===");

probe("8a: console.assert (no plugin rules)", `console.assert(1 === 1, "msg");`, true);

probe("8b: console.assert with debug-strip active", `console.assert(1 === 1, "msg");`, false);

probe(
  "8c: TypeScript assert function (no plugin rules)",
  `function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}
assert(true, "ok");`,
  true,
);

probe(
  "8d: Lua assert via TSTL language extensions (no plugin rules)",
  // $range and other TSTL extensions — check if assert is available as a global
  `const x: number = 5;
if (x < 0) { throw new Error("negative"); }`,
  true,
);

console.log("\n=== AUDIT COMPLETE ===\n");
