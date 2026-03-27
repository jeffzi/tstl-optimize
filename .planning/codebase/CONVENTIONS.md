# Coding Conventions

**Analysis Date:** 2026-03-26

## Naming Patterns

**Files:**

- kebab-case for multi-word file names: `conditional-compilation.ts`, `math-intrinsics.ts`, `debug-strip.ts`, `loop-rebase.ts`
- camelCase for single-word files: `inline.ts`, `config.ts`, `scope.ts`
- Test files use `.test.ts` suffix: `inline.test.ts`, `ts-ast.test.ts`

**Functions:**

- camelCase for all functions: `getBodyExpression()`, `canInline()`, `isMathMethodCall()`, `buildSqrt()`, `countReferences()`
- Helper function naming is descriptive: `handleCallExpression()`, `isParamWritten()`, `needsParentheses()`
- Builder functions prefixed with `build`: `buildSqrt()`, `buildFloor()`, `buildAbs()`, `buildMinMax()`
- Checker/validator functions prefixed with `is`/`has`: `hasInlineTag()`, `isMathMethodCall()`, `isModuleScopeDeclaration()`, `hasSideEffects()`
- Internal helper function names use verb-first pattern: `queueTemplateSpans()`, `extractLua()`, `substituteParams()`

**Variables:**

- camelCase for all variables: `bodyExpr`, `paramMap`, `declaredSymbol`, `luaTarget`
- Config objects suffixed with `Config`: `DebugStripConfig`, `LocalizerConfig`, `ConditionalCompilationConfig`
- Type guard return types use positive language: `InlineTarget`, `CompileResult`
- Error/reason returns use union discriminant: `{ target: ... } | { reason: ... } | undefined`
- Loop counters and accumulators use single letters in tight scopes: `i`, `n`, `count`
- Prefixes for related variables: `luaBody`, `luaArg`, `luaTarget`, `paramSymbol`, `resolvedSymbol`, `functionSymbol`

**Types:**

- PascalCase for all types: `InlineTarget`, `CompileOptions`, `RuleFactory`, `PluginConfig`, `LocalizerScope`
- Discriminated union types use clear property names: `{ target: InlineTarget } | { reason: string }`
- Readonly config objects use `readonly` modifier: `ReadonlySet`, `ReadonlyMap`
- Type aliases for discriminated unions documented via JSDoc: `InlineTargetResult`

## Code Style

**Formatting:**

- Line width: 100 characters (enforced by Biome)
- Indent: 2 spaces
- Quote style: double quotes
- Semicolons: always required
- Configured in `biome.json`

**Linting:**

- Tool: Biome 2.4.0
- All recommended rules enabled
- Strict rules enforced:
  - `noParameterAssign`: error - forbids reassigning function parameters
  - `useDefaultParameterLast`: error - default params must be at end
  - `noUnusedTemplateLiteral`: error - literal parts of template strings must be used
  - `noUselessElse`: error - else after return/throw is redundant
  - `noUnusedImports`: error - all imports must be used
  - `noUnusedVariables`: error - all variables must be used
  - `noUnusedFunctionParameters`: error - all parameters must be used
  - `noNamespaceImport`: error - forbids `import * as foo` except where documented (see below)

**Linting Exceptions:**

- Namespace imports allowed ONLY for TSTL and TypeScript, marked with `// biome-ignore lint/performance/noNamespaceImport: [reason]`:
  - `import * as tstl from "typescript-to-lua"` - TSTL has no default export
  - `import ts from "typescript"` - uses namespace extensively for type checks
- Example files (`examples/**`) have relaxed unused variable rules since they're for demonstration

## Import Organization

**Order:**

1. TypeScript imports: `import ts from "typescript"`
2. TSTL imports: `import * as tstl from "typescript-to-lua"` (with biome-ignore comment)
3. Internal utility/type imports: `import { hasSideEffects } from "../ast/ts-ast"`
4. Config/framework imports: `import type { RuleFactory } from "../config"`
5. Test utilities (in test files): `import { describe, expect, it } from "vitest"`

**Aliases:**

- No path aliases configured - all imports use relative paths
- Relative imports navigate via `../` to cross subdirectories: `../ast/ts-ast`, `../config`
- Type-only imports use `import type` syntax: `import type { RuleFactory } from "../config"`

## Error Handling

**Patterns:**

- Validation returns discriminated unions for clarity:

  ```typescript
  type InlineTargetResult = { target: InlineTarget } | { reason: string } | undefined;
  const result = getInlineTarget(node, checker);
  if (!result) return undefined;
  if ("reason" in result) { /* handle error */ }
  ```

- Rejection reasons are human-readable diagnostic messages: `"body must be a single return statement or arrow expression"`
- Early returns prevent nesting: check conditions first, return undefined/false if invalid
- Validation collects reasons rather than failing fast (except where multiple returns are needed)

**Diagnostic Creation:**

- `ts.DiagnosticCategory.Warning` for non-fatal issues (e.g., `@inline` applied but couldn't inline)
- Custom diagnostic codes in 90000+ range: `code: 90001` for tstl-optimize plugin
- Diagnostic source set to `"tstl-optimize"` to filter warnings in test helpers

## Logging

**Framework:** TypeScript compiler diagnostics system

**Patterns:**

- No console logging used in production code (Biome rule `noConsole: warn`)
- Diagnostics pushed to `context.diagnostics` array via `context.diagnostics.push(diagnostic)`
- Test helpers filter diagnostics by source: `diagnostics.filter(d => d.source === "tstl-optimize")`
- Diagnostic messages are structured for developer consumption:

  ```typescript
  const createInlineWarning = (node: ts.CallExpression, reason: string): ts.Diagnostic => ({
    file: node.getSourceFile(),
    start: node.getStart(),
    length: node.getWidth(),
    messageText: `@inline ignored: ${reason}`,
    category: ts.DiagnosticCategory.Warning,
    code: 90001,
    source: "tstl-optimize",
  });
  ```

## Comments

**When to Comment:**

- JSDoc on exported functions and types (not internal helpers)
- Inline comments only for non-obvious logic or algorithm explanations
- Comments explain _why_, not _what_ (code explains what)
- Comments in complex visitor registration explain ordering/priority

**JSDoc/TSDoc:**

- Used for exported types and functions: `/** Returns true if the expression could have side effects. */`
- Parameter documentation for complex types: `option: SideEffectOptions` includes description in JSDoc
- No JSDoc on internal helper functions unless behavior is surprising
- Example:

  ```typescript
  /**
   * Returns true if the expression could have side effects.
   *
   * By default, `new` and tagged templates are treated as side-effectful.
   * Pass `SideEffectOptions` flags to opt out of either assumption.
   */
  export function hasSideEffects(
    node: ts.Expression,
    options: SideEffectOptions = SideEffectOptions.None,
  ): boolean
  ```

## Function Design

**Size:**

- Small, focused functions (typically 10-40 lines)
- Large functions broken into smaller helpers with descriptive names
- Exception: tree-walking visitors allowed to be longer for readability of the switch statement

**Parameters:**

- Max 3-4 parameters; use objects for config with many options
- Required parameters before optional
- Config objects use default parameters: `options: SideEffectOptions = SideEffectOptions.None`
- Checker/context pattern: functions that need `ts.TypeChecker` and `tstl.TransformationContext` take both as parameters

**Return Values:**

- Early returns to avoid nesting
- Return `undefined` to signal "not handled" in visitor chains (protocol documented in comments)
- Discriminated unions for results with multiple possible outcomes
- Consistent null/undefined - use `undefined` (not `null`) as unset sentinel
- Example pattern from visitor chains:

  ```typescript
  const fn = (node: ts.Node, context: tstl.TransformationContext) => {
    const result = fn(node, context);
    if (result !== undefined) return result;
    // Fall through
  };
  ```

## Module Design

**Exports:**

- Default export for plugin factory function: `export default (options?: Record<string, unknown>): OptimizePlugin`
- Named export for class: `export { OptimizePlugin }`
- Type exports use `export type`: `export type RuleFactory = ...`
- Each rule file exports `createVisitors: RuleFactory`
- Config module exports resolver functions: `resolveDebugStripConfig()`, `resolveLocalizerConfig()`, `parseConfig()`

**Barrel Files:**

- No barrel files used in this codebase
- Each module imported directly: `import { OptimizePlugin } from "../src/index"`
- Test helpers co-located in test directory

---

Convention analysis: 2026-03-26
