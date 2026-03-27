# Codebase Concerns

**Analysis Date:** 2026-03-26

## Critical Issues

### Localizer: Metatable Chain Hoisting Breaks Stateful Proxies

**Issue:** The localizer hoists deep table chains like `assert.are_not.equal` into module-level locals, breaking libraries that use metatable `__index` chains (e.g., busted/luassert) where intermediate accesses return stateful proxy objects.

**Root cause:** When a chain like `assert.are_not.equal` is hoisted as a single local, the intermediate `assert.are_not` access is elided. In libraries with `__index` metatables, this intermediate access sets internal state (e.g., a negation flag). Capturing the final function without the intermediate state loses the flag, and the hoisted function behaves as the negation was never applied.

**Affected code:** `src/rules/localizer.ts` (lines 36-68, hoisting logic in `hoistScope`)

**Files:**

- `src/rules/localizer.ts`
- `src/ast/scope.ts` (collectScopeInfo)

**Impact:**

- Test assertions using metatable-based libraries fail silently
- Affects any library using metatable chaining (luassert, middleclass, penlight, user-defined metatables)
- Workaround: Users must disable the localizer rule for affected code

**Fix approach:**
Add an `excludeRoots: string[]` config option to LocalizerConfig:

- In `src/config.ts`: Add `excludeRoots?: string[]` to `LocalizerConfig` interface, default to `[]`
- In `collectScopeInfo()` (`src/ast/scope.ts`): Skip any chain whose root identifier is in the exclusion set
- Default behavior unchanged for existing users
- Users opt out specific roots in tsconfig plugin options:

  ```json
  { "rules": { "localizer": { "excludeRoots": ["assert", "describe", "it"] } } }
  ```

**Rejected alternatives:**

1. Depth cap (max 2 segments) — Too blunt. Breaks legitimate deep chains like `config.graphics.width`
2. Blocklist test globals — Too narrow. Doesn't cover all libraries with metatables
3. Heuristic: skip unprovable plain tables — Infeasible. Localizer operates post-transpile on Lua AST where no type information survives

**Severity:** High — Silently breaks test frameworks and user code

---

## Performance Bottlenecks

### Investigation: Phantom Performance Regressions on ECS Benchmarks

**Problem:** Initial benchmarking of tstl-optimize on ecstatic's ECS test suite reported large, consistent performance differences (2-4x regressions) that were later revealed to be measurement artifacts.

**Files:** `TODO.md` (lines 49-145)

**Root cause analysis:**
The initial benchmark used broken setup: ecstatic's `bench-ecs.mjs` set a hardcoded `LUA_PATH` pointing at the working tree's `lua/` directory. Since `lua/` is gitignored, luabench's baseline reference (cloned into a temp dir) had no transpiled files. Both targets resolved `require("src.ecs")` to the **same** working-tree `lua/` via `LUA_PATH`, meaning both ran identical code yet reported 2-4x differences.

With proper per-ref transpilation (`--prepare` flag, each ref runs in its own clone), results changed completely:

- **Lua 5.1**: Only `despawn` n=10000 showed 1.14x regression (within noise)
- **LuaJIT -joff**: No significant regressions

**Impact:**

- Confidence in rule performance gains is reduced
- Need to validate future benchmarks use proper isolation
- Performance characteristics are likely neutral-to-positive on both interpreters

**Improvement path:**

1. Verify all future benchmarks use `--prepare` for proper isolation
2. Document baseline measurement methodology
3. Re-run benchmarks on real-world codebases to establish confidence

**Why this matters:** If rules consistently regress performance, the plugin provides value only for code size, not speed. Current evidence suggests they're neutral, but setup was flawed.

---

## Type Safety & Unsafe Patterns

### Unsafe Type Cast in Plugin Visitor Merging

**Issue:** Dynamic visitor merging uses `as unknown as tstl.Visitors` type cast to bypass strict visitor type constraints.

**Location:** `src/index.ts` (line 101)

```typescript
// Safe: each key was originally from a well-typed Visitors object
this.visitors = merged as unknown as tstl.Visitors;
```

**Risk:** The cast assumes all dynamically merged visitor functions have correct signatures. If a rule's visitor function has a signature mismatch (e.g., returns wrong type, handles wrong SyntaxKind), the cast masks it. This can only be caught at runtime when TSTL invokes the visitor.

**Mitigation:** The comment claims safety because "each key was originally from a well-typed Visitors object" — this is true as long as:

1. Each rule's factory function returns a properly typed `tstl.Visitors` object
2. Dynamic merging only combines already-typed visitor functions

**Test coverage:** Visitor merging is tested in `test/index.test.ts`, but tests cover only successful cases, not type mismatch scenarios.

**Improvement path:**

- Add tests for visitor merging with intentionally wrong-typed functions to ensure errors surface clearly
- Add TSDoc comment explaining why the cast is safe
- Consider TypeScript overloads to type-check merging more precisely

---

## Test Coverage Gaps

### Incomplete Coverage in High-Complexity Rules

**Files with coverage gaps:**

- `src/rules/localizer.ts` (300 lines, 90%+ coverage) — Complex multi-pass algorithm for hoisting chains and array elements
- `src/rules/inline.ts` (309 lines, 90%+ coverage) — Parameter substitution across multiple expression types
- `src/ast/lua-walker.ts` (244 lines, 90%+ coverage) — Recursive expression traversal with control flow

**Current coverage:** Vitest configured for 90% thresholds on all metrics (lines, functions, branches, statements) — meeting this threshold leaves ~10% of branches untested.

**What's missing:**

- Edge cases in `substituteParams` (`src/rules/inline.ts` lines 166-238): Not all expression types (ternary, parenthesized, table literals) have dedicated test cases for parameter substitution
- Loop body traversal in lua-walker (`src/ast/lua-walker.ts`): Stop/skip flags in nested loops not fully tested
- Array element hoisting write-back scenarios (`src/rules/localizer.ts` lines 157-218): Edge cases where write-back is suppressed (early exit + write) have limited coverage

**Priority:** Medium — Coverage is near threshold, but these are areas where subtle bugs could hide (e.g., incorrect parameter substitution affecting inlining correctness)

**Improvement path:**

1. Review test/rules/inline.test.ts for coverage gaps in substituteParams and needsParentheses
2. Add tests for lua-walker control flow (stop in nested loops, skip inside conditions)
3. Add tests for localizer write-back suppression with mixed early-exit/write patterns

---

## Known Limitations & Design Trade-offs

### Math Intrinsics: Lossiness on IEEE 754 Edge Cases

**Issue:** Math intrinsics rule inlines `Math.abs`, `Math.min`, and `Math.max` in ways that deviate from IEEE 754 semantics.

**Location:** `src/rules/math-intrinsics.ts` (lines 1-147)

**Deviations:**

- `Math.abs(x)` → `(x < 0) and -x or x` — Returns `-0` instead of `0` for `-0` input (Math.abs(-0) === 0)
- `Math.max(a, b)` → `(a > b) and a or b` — Returns `b` when either arg is `NaN`; actual Math.max returns `NaN`
- `Math.min(a, b)` → `(a < b) and a or b` — Returns `b` when either arg is `NaN`; actual Math.min returns `NaN`

**Why allowed:** Typical Lua 5.1 game code never observes `-0` or `NaN`. These are deliberate trade-offs for performance.

**Impact:** Code relying on IEEE 754 semantics will silently produce wrong results. No warning is emitted.

**Users affected:** Scientific computing, financial calculations, code migrating from JavaScript where NaN semantics matter

**Fix approach:** Document clearly in README (already done). Users who need IEEE semantics should disable the rule.

---

### Conditional Compilation: Name-Based Constant Matching

**Issue:** Conditional compilation rule matches constants by identifier name, not by TypeScript type. A local variable shadowing a compile-time constant name will also be substituted.

**Location:** `src/rules/conditional-compilation.ts` (lines 14-66)

**Example:**

```typescript
// In config: DEBUG constant
// In code:
const DEBUG = true; // local variable
if (DEBUG) { ... }  // Rule substitutes this DEBUG with config value, not local
```

**Risk:** Silent behavior change if a local shadows a constant name

**Mitigation:** Rule only applies to top-level constant expressions (checked via type system during matching), but substitution is name-based, creating a mismatch

**Improvement path:**

- Emit a diagnostic warning when a local shadows a declared constant
- Or: require `declare const` at module scope for constants to be recognized

---

### Localizer & Debug-Strip: Name-Based Function/Namespace Matching

**Issue:** Both rules match functions and namespaces by text identifier, not by symbol resolution. A local function or namespace named `print` will also be stripped by debug-strip.

**Location:**

- `src/rules/debug-strip.ts` — Function/namespace name matching
- `src/rules/localizer.ts` — No symbol tracking, only text-based chain matching

**Risk:** If a user defines their own `print` or `debug` namespace, they get stripped when debug-strip is enabled

**Impact:** Silent code removal. The user's custom functions are removed instead of globals.

**Mitigation:** Currently documented in README as a limitation. Users must be aware.

---

## Fragile Areas

### Complex Control Flow in Localizer Hoisting

**Fragility:** The localizer performs multi-pass analysis (collectScopeInfo, then hoistArrayElements with early-exit detection) across multiple functions with shared mutable state. The interaction between:

1. Write-back suppression when early exits are present (`hasEarlyExit()`)
2. Loop variable consistency checking (`mixedIndex` set)
3. Scope definition tracking (`scopeDefs`)

…creates brittle interdependencies.

**Files:** `src/rules/localizer.ts` (entire file, especially hoistArrayElements lines 157-218)

**Mutation patterns:**

- `scopeDefs` is mutated and checked in multiple passes
- `hoistedAtModule` set is carried between module and function passes (line 233-234)
- Early-exit detection is conservative (any return/break anywhere in scope blocks write-back)

**Safe modification:**

- Any change to `hasEarlyExit()` logic must be re-tested with the full localizer test suite (625 lines in test/rules/localizer.test.ts)
- Adding new hoisting patterns (e.g., for user-defined indexing) requires careful interaction testing with early-exit and scope checks

**Test coverage:** 625 lines of tests, but ~10% branch gap remains. Edge cases: deeply nested returns inside if/do blocks, mixed early-exit + array write scenarios

---

### Visitor Merging & Rule Ordering

**Fragility:** Rule execution order is hardcoded in `src/index.ts` (lines 15-22), and some rules depend on the order. Changes to rule precedence can break dependent rules.

**Current order:** conditional-compilation (lowest) → math-intrinsics → loop-rebase → inline → localizer → debug-strip (highest)

**Dependencies:**

- `conditional-compilation` must run first: it strips dead branches, leaving cleaner code for other rules to optimize
- `inline` depends on `localizer`: inlined function bodies may contain chains to hoist
- `debug-strip` runs last: removes stripped calls that earlier rules may have optimized

**Risk:** Reordering without understanding dependencies can cause:

1. Rules to see more/less dead code than expected
2. Inlined code to not get localized
3. Debug calls to not be stripped after transformation

**Safe modification:** Before reordering, test the full suite with new order to catch unexpected interactions. Rule order should be documented with rationale.

---

## Dependencies at Risk

### TypeScript-to-Lua Version Coupling

**Issue:** Plugin is tightly coupled to TSTL API surface. Changes in TSTL (AST structure, visitor protocol, transformation context) break the plugin.

**Dependency:** `typescript-to-lua >= 1.22.0` (peer dependency)

**Location:** Virtually all rule files import `tstl` and depend on:

- AST node type guards (`tstl.isIdentifier()`, etc.)
- Visitor registration protocol
- Transformation context API

**Risk:** TSTL version bumps can require rewrites of multiple rule implementations. No abstraction layer exists to isolate changes.

**Current situation:** Plugin is tested against TSTL 1.33.0. Compatibility with future major versions unknown.

**Improvement path:**

- Define an abstraction layer for TSTL API dependencies
- Maintain compatibility table for TSTL versions
- Consider pinning TSTL version in dev dependencies (currently accepts >=1.22.0)

---

## Scaling Limits

### Plugin Registration & Visitor Chaining

**Capacity:** The plugin uses dynamic visitor merging to chain multiple rules on the same SyntaxKind. Maximum capacity depends on:

1. Number of rules (currently 6, see line 15-22 in src/index.ts)
2. Number of shared SyntaxKinds (currently 5 expression kinds, see line 27-33)
3. Visitor function call overhead

**Current usage:** Most expression kinds handled by 1-2 rules. Worst case: CallExpression (handled by inline, localizer, conditional-compilation).

**Scaling risk:** If future rules target the same expression kinds, visitor chain depth increases. Each rule in the chain adds a function call. For deep chains, overhead could become measurable.

**Performance:** No benchmark of visitor chaining overhead exists. Assumed negligible for 6 rules, but untested.

**Future:** Adding 10+ rules could create noticeable overhead in compilation time.

---

## Missing Critical Features

### No Warning on Constant Shadowing

**Gap:** Conditional compilation rule allows local variables to shadow compile-time constants with no diagnostic warning. This can silently change program behavior.

**Example:**

```typescript
const DEBUG = false; // compile-time constant
if (DEBUG) { ... }   // stripped

function foo() {
  const DEBUG = true; // local, shadows constant
  if (DEBUG) { ... }  // rule doesn't know to skip this (actually SKIPPED - name-based match catches it!)
}
```

Actually, the rule DOES substitute the local DEBUG (because it's name-based), which is the bug. No warning is emitted.

**Files:** `src/rules/conditional-compilation.ts`

**Workaround:** User must be careful not to shadow constant names locally

**Fix:** Emit a diagnostic when a local identifier shadows a compile-time constant name

---

### No Symbol-Based Resolution for Localizer

**Gap:** Localizer and debug-strip use text-based name matching instead of symbol resolution. This means they can't distinguish between:

- Module-level identifiers
- Imported identifiers
- Locally shadowed identifiers

**Risk:** Optimization applies to the wrong identifier (shadowed name, not global)

**Example:**

```typescript
const print = console.log; // local rename
print("debug"); // Rule sees "print" and strips it!
```

**Files:** `src/rules/debug-strip.ts`, `src/rules/localizer.ts`

**Fix approach:**

- For debug-strip: Use symbol resolution to identify stripped functions
- For localizer: Track symbol definitions to avoid hoisting shadowed names

---

### No Configuration Validation or Error Reporting

**Gap:** Config parsing in `src/config.ts` silently ignores malformed options instead of reporting errors.

**Example:**

```json
{
  "plugins": [
    {
      "name": "tstl-optimize",
      "rules": {
        "localizer": { "threshold": "invalid" }  // should be number, silently ignored
      }
    }
  ]
}
```

**Behavior:** The invalid config is ignored, rule uses defaults. User has no indication their config is wrong.

**Location:** `src/config.ts` (parseConfig function, lines 122-152)

**Fix:** Add validation and emit diagnostics for invalid config values
