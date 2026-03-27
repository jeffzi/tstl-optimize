# Testing Patterns

**Analysis Date:** 2026-03-26

## Test Framework

**Runner:**

- Vitest 4.0.0
- Config: `vitest.config.ts`

**Assertion Library:**

- Vitest's built-in assertions (expect API)

**Run Commands:**

````bash
npm run test:unit              # Run all unit tests (vitest run)
npm run test                   # Run unit tests + conformance tests
npm run test -- --watch       # Watch mode (not in package.json)
npm run test -- --coverage    # Run with coverage report
```text

## Test File Organization

**Location:**

- Co-located with source: test files mirror src structure
- `test/` directory mirrors `src/` layout:
  - `test/index.test.ts` ↔ `src/index.ts`
  - `test/rules/inline.test.ts` ↔ `src/rules/inline.ts`
  - `test/ast/ts-ast.test.ts` ↔ `src/ast/ts-ast.ts`

**Naming:**

- Suffix: `.test.ts` for all test files
- File name matches source file: `inline.ts` → `inline.test.ts`
- Pattern consistent across entire project

**Structure:**

```text
test/
├── index.test.ts
├── helpers.ts                    # Shared test utilities
├── rules/
│   ├── inline.test.ts
│   ├── math-intrinsics.test.ts
│   ├── localizer.test.ts
│   ├── debug-strip.test.ts
│   ├── loop-rebase.test.ts
│   └── conditional-compilation.test.ts
└── ast/
    ├── ts-ast.test.ts
    ├── lua-walker.test.ts
    └── scope.test.ts
```text

## Test Structure

**Suite Organization:**

```typescript
describe("feature or component name", () => {
  describe("positive: descriptive outcome", () => {
    it("specific behavior", () => {
      // Test implementation
    });
  });

  describe("negative: when invalid", () => {
    it("rejects X with reason Y", () => {
      // Test implementation
    });
  });

  describe("edge case: X scenario", () => {
    it("handles Y correctly", () => {
      // Test implementation
    });
  });
});
```text

**Patterns:**

- Outer `describe` block for rule/module name
- Inner `describe` blocks organize by outcome: `"positive: ..."`, `"negative: ..."`, `"edge case: ..."`
- Each `it()` is a single behavior assertion
- Nested structure prevents flat, overwhelming test lists
- Example from `test/index.test.ts`:

  ```typescript
  describe("default export", () => {
    it("is a factory function so TSTL passes plugin options from tsconfig", () => {
      expect(typeof pluginFactory).toBe("function");
    });
  });

  describe("plugin infrastructure", () => {
    it("produces Lua output with default or empty config", () => {
      expect(compile("const x = 1;")).toContain("x = 1");
    });
  });
````

## Mocking

**Framework:** Vitest (built-in mocking via `vi` module available but not heavily used)

**Patterns:**

- No external mock libraries imported in tests
- Test helper `compile()` function creates a real plugin instance with real TSTL transpilation
- Complex behaviors tested through integration (transpile full code) rather than unit mocks
- Diagnostics system mocked implicitly via `compileWithDiagnostics()` helper which filters results

**What to Mock:**

- Not typically needed - compile helpers handle plugin setup
- TSTL transpilation is real; tests verify actual Lua output

**What NOT to Mock:**

- TypeScript compiler or type checker (tests use real checker)
- TSTL transformer (tests verify real transformation output)
- Lua generation (actual Lua code output is verified)

## Fixtures and Factories

**Test Data:**

````typescript
// Inline source code in tests (for clarity and tight scope)
const lua = compile(`
  /** @inline */
  function double(x: number) { return x * 2; }
  declare const a: number;
  const r = double(a);
`);
expect(lua).toContain("a * 2");

// Type declarations for tests
interface CompileOptions {
  pluginOptions?: Record<string, unknown>;
  luaTarget?: tstl.LuaTarget;
  luaLibImport?: tstl.LuaLibImportKind;
}

interface CompileResult {
  lua: string;
  diagnostics: ts.Diagnostic[];
}
```text

**Helper Functions Location:**

- `test/helpers.ts` - Shared compilation and transpilation utilities
- Core helpers: `compile(source, options)`, `compileWithDiagnostics(source, options)`
- Low-level: `transpile()` (not exported), `extractLua()` (not exported)

**Fixture Pattern:**

```typescript
export function compile(source: string, options?: CompileOptions): string {
  return extractLua(transpile({ "main.ts": source }, options));
}

export function compileWithDiagnostics(source: string, options?: CompileOptions): CompileResult {
  const result = transpile({ "main.ts": source }, options);
  const lua = extractLua(result);
  const diagnostics = result.diagnostics.filter((d) => d.source === "tstl-optimize");
  return { lua, diagnostics };
}
```text

## Coverage

**Requirements:**

- 90% threshold on all metrics (lines, functions, branches, statements)
- Configured in `vitest.config.ts`:

  ```typescript
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    thresholds: {
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    },
  }
````

**View Coverage:**

````bash
npm run test -- --coverage        # Generate coverage report
# Report appears in coverage/ directory with HTML output
```text

## Test Types

**Unit Tests:**

- Scope: Individual rule implementations, helper functions, config parsing
- Approach: Transpile small TypeScript code snippets, verify Lua output
- Example: `test/rules/inline.test.ts` tests inline function behavior by compiling and checking output
- Tests focus on transformation behavior not implementation details

**Integration Tests:**

- Scope: Plugin initialization, rule combination effects, TSTL integration
- Approach: Full transpilation with real TSTL compiler and TypeScript type checker
- Example: `test/index.test.ts` verifies plugin works with TSTL's plugin system
- Conformance tests in separate script: `node scripts/conformance.mjs`

**E2E Tests:**

- Framework: Conformance test suite (TypeScriptToLua test repository)
- Run via: `npm run test:conformance`
- Coverage: Real-world TSTL project compatibility, regression detection
- Not directly in this codebase; uses external test suites from TSTL

## Common Patterns

**Assertion Pattern:**

```typescript
// Check output contains expected Lua
expect(lua).toContain("expectedLuaCode");

// Verify removed/not present
expect(lua).not.toContain("functionName(");

// Type checking
expect(typeof pluginFactory).toBe("function");

// Deep equality
expect(config.rules.localizer).toStrictEqual({ threshold: 5 });
```text

**Async Testing:**

- Not heavily used (plugin is synchronous)
- TSTL's `transpileVirtualProject()` is synchronous
- Conformance test script is separate Node process (asynchronous, handled by task runner)

**Error Testing:**
Pattern from `test/index.test.ts`:

```typescript
it("rejects when diagnostic reason present", () => {
  const { lua, diagnostics } = compileWithDiagnostics(`
    /** @inline */
    function bad() { return undefined; }
    const x = bad();
  `);
  // Must have warning diagnostic
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics[0].messageText).toContain("@inline ignored");
});
```text

**Parametrized Tests:**

```typescript
it.each(["puc", "luajit"] as const)("accepts '%s' as target", (target) => {
  expect(parseConfig({ target }).target).toBe(target);
});
```text

## Test Coverage Details

**Tested Areas:**

- Plugin factory and initialization (`test/index.test.ts`)
- Config parsing and rule enablement logic (`test/index.test.ts`)
- Each optimization rule behavior (`test/rules/*.test.ts`)
- AST utilities and side-effect detection (`test/ast/*.test.ts`)
- Lua AST walking and transformation (`test/ast/lua-walker.test.ts`)
- Variable scope analysis (`test/ast/scope.test.ts`)

**Key Test Files:**

- `test/index.test.ts` (153 lines) - Plugin infrastructure, config, auto-detection
- `test/rules/inline.test.ts` - Function inlining, parameter handling, edge cases
- `test/rules/math-intrinsics.test.ts` - Math.floor, Math.sqrt, Math.abs, Math.min/max
- `test/rules/localizer.test.ts` - Variable localization logic
- `test/rules/debug-strip.test.ts` - Debug function/namespace stripping
- `test/rules/loop-rebase.test.ts` - For-in loop variable handling
- `test/ast/ts-ast.test.ts` - Side-effect detection for complex expressions

---

_Testing analysis: 2026-03-26_
````
