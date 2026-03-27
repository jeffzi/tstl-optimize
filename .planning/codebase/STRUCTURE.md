# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

````text
tstl-optimize/
├── src/                    # TypeScript source code (compiled to dist/)
│   ├── index.ts            # Plugin entry point, visitor orchestration
│   ├── config.ts           # Configuration parsing and defaults
│   ├── rules/              # Six optimization rules
│   │   ├── conditional-compilation.ts
│   │   ├── math-intrinsics.ts
│   │   ├── loop-rebase.ts
│   │   ├── inline.ts
│   │   ├── localizer.ts
│   │   └── debug-strip.ts
│   └── ast/                # Shared AST utilities
│       ├── ts-ast.ts       # TypeScript expression analysis
│       ├── lua-walker.ts   # Lua statement/expression traversal
│       └── scope.ts        # Lua scope analysis
├── test/                   # Vitest suite
│   ├── index.test.ts       # Plugin infrastructure tests
│   ├── helpers.ts          # Shared test utilities (compile, transpile)
│   ├── rules/              # Rule-specific tests
│   │   ├── conditional-compilation.test.ts
│   │   ├── math-intrinsics.test.ts
│   │   ├── loop-rebase.test.ts
│   │   ├── inline.test.ts
│   │   ├── debug-strip.test.ts
│   │   └── localizer.test.ts
│   └── ast/                # AST utility tests
│       ├── ts-ast.test.ts
│       ├── lua-walker.test.ts
│       └── scope.test.ts
├── dist/                   # Compiled JavaScript output (build artifact)
├── examples/               # Runnable example TypeScript files demonstrating rules
├── scripts/                # Node.js build/validation scripts
│   ├── conformance.mjs     # Verify TSTL conformance (runs against TSTL repo)
│   ├── examples.mjs        # Compile examples; verify output
│   └── bench.mjs           # Benchmark harness
├── package.json            # Dependencies, scripts, version
├── tsconfig.plugin.json    # TypeScript compiler config (src/ build)
├── biome.json              # Biome linter/formatter config
├── knip.json               # Unused export detector config
├── .commitlintrc.json      # Commit message validation
├── .markdownlint-cli2.jsonc # Markdown linter rules
├── dprint.json             # Additional dprint formatter rules
├── lefthook.yml            # Git pre-commit hook config
└── .github/workflows/      # CI/CD workflows
```text

## Directory Purposes

**src/ (main source code):**

- Purpose: TypeScript source files; compiled to dist/ for distribution
- Contains: Plugin, rules, AST utilities
- Key files: `index.ts`, `config.ts`

**src/rules/ (optimization rules):**

- Purpose: Each rule is an independent optimization; encapsulated in own file
- Contains: `createVisitors` factory + rule implementation
- Key files: All six `{name}.ts` files

**src/ast/ (AST utilities):**

- Purpose: Shared analysis and traversal functions used by multiple rules
- Contains: TypeScript side-effect analysis, Lua walker, scope analysis
- Key files: `ts-ast.ts`, `lua-walker.ts`, `scope.ts`

**test/ (test suite):**

- Purpose: Vitest unit tests
- Contains: Rule tests, plugin tests, AST utility tests
- Key files: `helpers.ts` (test infrastructure), `index.test.ts` (plugin tests)

**test/rules/ (rule-specific tests):**

- Purpose: One test file per rule; tests both enable/disable behavior and edge cases
- Contains: Test cases for each rule's optimization
- Key files: Co-located with rules (e.g., `test/rules/inline.test.ts` tests `src/rules/inline.ts`)

**test/ast/ (AST utility tests):**

- Purpose: Isolated tests for side-effect analysis, walker, scope collection
- Contains: Edge case tests for AST functions
- Key files: `ts-ast.test.ts`, `lua-walker.test.ts`, `scope.test.ts`

**dist/ (compiled output):**

- Purpose: Built JavaScript (CommonJS) published to npm
- Contains: Compiled .js files + .d.ts type declarations
- Generated: By `npm run build` (tsc)
- Committed: Yes (via prepack script for git dependency installs)

**examples/ (runnable examples):**

- Purpose: Demonstrate each rule in action; compiled by `npm run examples`
- Contains: TypeScript files; Lua output in `.lua` sidecars or separate dir
- Key files: One per rule or feature

**scripts/ (build automation):**

- Purpose: Node.js scripts for conformance testing, example compilation, benchmarking
- Contains: `conformance.mjs`, `examples.mjs`, `bench.mjs`
- Used by: npm scripts (test:conformance, examples, bench)

**benchmark/ (performance testing):**

- Purpose: Benchmark harness and test data for performance regression detection
- Contains: Lua test files, JIT vs PUC Lua runner configs
- Generated: By bench tasks

## Key File Locations

**Entry Points:**

- `src/index.ts`: Plugin factory and `OptimizePlugin` class; orchestrates rule visitors
- Exports: Default export (factory function), named export (`OptimizePlugin`)

**Configuration:**

- `src/config.ts`: Config types, defaults, parsing, resolution functions
- Exports: All interfaces (`PluginConfig`, `RulesConfig`, rule-specific configs), parsers

**Core Logic:**

- `src/rules/*.ts`: Each rule implements `createVisitors()` factory
- `src/ast/*.ts`: Shared utilities used by multiple rules

**Testing:**

- `test/helpers.ts`: Core test helper (`compile()`, `compileWithDiagnostics()`)
- `test/index.test.ts`: Plugin infrastructure, config parsing tests
- `test/rules/*.test.ts`: Rule behavior tests

**Build Configuration:**

- `tsconfig.plugin.json`: TypeScript compilation config for src/
- `package.json`: npm scripts, version, dependencies
- `biome.json`: Code formatting and linting rules

**Documentation & Validation:**

- `.markdownlint-cli2.jsonc`: Markdown rules
- `knip.json`: Detect unused exports (run via `npm run check:unused`)
- `.commitlintrc.json`: Enforce conventional commits

## Naming Conventions

**Files:**

- Rules: `src/rules/{kebab-case-name}.ts` (e.g., `conditional-compilation.ts`)
- Tests: `test/{dir}/{same-name}.test.ts` (e.g., `test/rules/inline.test.ts`)
- Exports: Functions are `camelCase`, interfaces are `PascalCase`, types are `camelCase`

**Directories:**

- src: Contains only TypeScript source (no generated code)
- test: Mirror structure of src/ for file co-location
- dist: Build output (not source)

**Functions & Exports:**

- Factory functions: `createVisitors` (standard across all rules)
- Visitor callbacks: `transformExpression`, `transformStatement` (TSTL convention)
- Utilities: `hasSideEffects()`, `walkStatements()`, `collectScopeInfo()` (verb + noun)
- Config resolvers: `resolve{RuleName}Config()` (standard pattern)

**Variables:**

- Private rule state: `rule_` prefix or closure-local (avoid file-level mutation)
- TypeScript types: `ts.` namespace or imported types
- Lua AST types: `tstl.` namespace
- Maps/Sets: descriptive names (`chainCounts`, `scopeDefs`, `hoisted`)

## Where to Add New Code

**New Optimization Rule:**

1. Create `src/rules/{rule-name}.ts`
2. Implement `createVisitors(checker: ts.TypeChecker, config: PluginConfig): tstl.Visitors`
3. Register in `src/index.ts` `RULE_ENTRIES` array + `EXPRESSION_KINDS` set if needed
4. Add config interface to `src/config.ts` and defaults
5. Create `test/rules/{rule-name}.test.ts` with at minimum enable/disable tests
6. Add example file to `examples/` if complex

**New AST Utility:**

1. If TypeScript analysis: add to `src/ast/ts-ast.ts`
2. If Lua traversal: add to `src/ast/lua-walker.ts`
3. If scope analysis: add to `src/ast/scope.ts`
4. Export and add JSDoc
5. Create test in `test/ast/{file}.test.ts`

**New Test:**

1. Co-locate with source file: `test/{src-path}/{name}.test.ts`
2. Use `compile()` helper from `test/helpers.ts`
3. Use `describe()` and `it()` from vitest
4. For diagnostics tests, use `compileWithDiagnostics()`

**Configuration Option:**

1. Add interface to `src/config.ts`
2. Add to `RulesConfig` or new rule's interface
3. Add defaults to `DEFAULT_RULES` or `DEFAULT_{RULE}`
4. Add resolver function if complex (e.g., `resolveLocalizerConfig()`)
5. Update `parseConfig()` and `isRuleEnabled()` if needed

## Special Directories

**node_modules/:**

- Purpose: npm dependencies
- Generated: Yes (by npm install)
- Committed: No (.gitignore'd)

**dist/:**

- Purpose: Compiled JavaScript output
- Generated: Yes (by tsc)
- Committed: Yes (prepack script builds before npm publish)

**coverage/:**

- Purpose: Test coverage reports
- Generated: Yes (by vitest --coverage)
- Committed: No (.gitignore'd)

**.conformance/:**

- Purpose: TSTL conformance test outputs
- Generated: Yes (by conformance.mjs script)
- Committed: No (.gitignore'd)

**.planning/:**

- Purpose: GSD planning artifacts
- Generated: By planning tools
- Committed: No (.gitignore'd)

**.task/:**

- Purpose: go-task checksum cache
- Generated: By task runner
- Committed: No (.gitignore'd)

---

_Structure analysis: 2026-03-26_
````
