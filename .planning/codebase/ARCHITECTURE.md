# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** TSTL Plugin with Composable Visitor Pattern

The codebase implements a TypeScript-to-Lua (TSTL) compiler plugin that applies multiple independent optimization rules to AST transformations. The architecture uses a composable visitor pattern where each optimization rule registers its own visitors for specific TypeScript/Lua AST node types, and a central plugin orchestrates their execution with priority-based chaining.

**Key Characteristics:**

- Plugin-based architecture implementing the TSTL compiler plugin interface
- Rule-driven optimization system with configurable enable/disable per rule
- Multi-layered visitor merging to handle rule priority and chaining
- Dual-phase analysis: TypeScript AST inspection + Lua AST transformation
- Zero-dependency core (only peer dep: `typescript-to-lua`, runtime dep: `ts-api-utils`)

## Layers

**Plugin Layer:**

- Purpose: Entry point and orchestrator; receives TypeScript program, coordinates rule execution
- Location: `src/index.ts`
- Contains: `OptimizePlugin` class implementing TSTL plugin interface
- Depends on: All rule modules, config resolver
- Used by: TSTL compiler pipeline (external)
- Key method: `beforeTransform()` builds merged visitors; `beforeEmit()` post-processes Lua output

**Configuration Layer:**

- Purpose: Parse, validate, and resolve plugin configuration from tsconfig.json options
- Location: `src/config.ts`
- Contains: Config interfaces (RulesConfig, PluginConfig), resolvers, defaults
- Depends on: None (pure TypeScript types and validation)
- Used by: Plugin layer, rule factories

**Rule Layer (6 independent optimization rules):**

- Purpose: Each rule implements one optimization concern
- Location: `src/rules/{rule-name}.ts`
- Contains: `createVisitors` factory function + rule-specific logic
- Depends on: Config, AST utilities, ts-api-utils
- Used by: Plugin layer (dynamically called)

Rules:

- `conditional-compilation.ts` — Strips dead code branches via compile-time constants
- `math-intrinsics.ts` — Replaces Math.* calls with Lua arithmetic operations
- `loop-rebase.ts` — Optimizes for-in loop variable indexing
- `inline.ts` — Inlines functions marked with @inline JSDoc tag
- `localizer.ts` — Hoists repeated table property accesses to local variables
- `debug-strip.ts` — Removes debug/assert calls and namespaces (configurable)

**AST Utilities Layer:**

- Purpose: Shared analysis and traversal logic for both TypeScript and Lua ASTs
- Location: `src/ast/{ts-ast,lua-walker,scope}.ts`
- Contains: Side-effect detection, Lua statement/expression walking, scope analysis
- Depends on: TypeScript API, ts-api-utils

AST modules:

- `ts-ast.ts` — Side-effect analysis for TypeScript expressions (recursive queue-based walker)
- `lua-walker.ts` — Walk Lua statement lists; collect expressions with replace/skip/stop control
- `scope.ts` — Extract property chains and variable definitions from Lua statements

## Data Flow

**Initialization Phase:**

1. TSTL loads plugin via factory function (`src/index.ts` default export)
2. Plugin constructor calls `parseConfig()` to normalize tsconfig options into `PluginConfig`
3. `beforeTransform()` hook invoked with TypeScript `Program` and `CompilerOptions`

**Visitor Building Phase:**

1. `buildVisitors()` iterates `RULE_ENTRIES` in priority order (lowest → highest)
2. For each enabled rule, calls `createVisitors(checker, config)` to get its AST visitors
3. Merges visitors by SyntaxKind:
   - If multiple rules handle same kind, chains with priority (higher priority runs first, can return undefined to fall through)
   - Expression visitors wrapped with `superTransformExpression()` fallback when no rule handles node
   - Statement visitors return undefined = "erase" (intended behavior)
4. Final merged visitor map stored on plugin instance

**Transformation Phase:**

1. TSTL invokes registered visitors during TypeScript → Lua transformation
2. Each visitor receives `ts.Node` and `tstl.TransformationContext`
3. Visitor either:
   - Returns Lua expression/statement (handled)
   - Returns undefined (not handled; falls to next rule or default)
4. Lua output generated after all transformations

**Emit Phase:**

1. `beforeEmit()` post-processes generated Lua files
2. For `inline` rule: strips `@inline` JSDoc artifact comments

**State Management:**

- Plugin instance holds: type checker (from `beforeTransform`), parsed config, built visitors
- No global state; all rule state is local to visitor closures
- Type checker accessible to all rules via parameter (enables symbol resolution)

## Key Abstractions

**Rule Factory Pattern:**

- Purpose: Decouple rule definition from plugin orchestration
- Type: `RuleFactory = (checker: ts.TypeChecker, config: PluginConfig) => tstl.Visitors`
- Examples: Every `src/rules/{name}.ts` exports a `createVisitors` function
- Pattern: Factory receives dependency injection (checker, config); returns side-effect-free visitor object

**Visitor Merging with Priority:**

- Purpose: Allow multiple rules to handle same AST node kinds without collision
- Pattern: Chain visitors by kind; higher-priority runs first
- Fallback chain: rule1 → rule2 → superTransformExpression (for expressions only)
- Example: Conditional-compilation is lowest priority (strip dead code first); debug-strip is highest (clean up after all optimizations)

**Lua Property Chain Extraction:**

- Purpose: Recognize repeated table access patterns (e.g., `obj.prop.nested`) for localizer
- Examples: `src/ast/scope.ts` exports `luaPropertyChain()`
- Pattern: Walk from leaf to root, building dotted string; undefined if contains non-string indices

**Side-Effect Analysis (TypeScript):**

- Purpose: Determine if an expression is safe to skip/inline (guards inlining unsafe calls)
- Location: `src/ast/ts-ast.ts` — `hasSideEffects()`
- Pattern: Recursive queue-based traversal; classifies by expression kind (assignments, calls always have side effects; literals never do)

**Scope Information Collection (Lua):**

- Purpose: Gather variable definitions and chain usage counts in single pass
- Location: `src/ast/scope.ts` — `collectScopeInfo()`
- Pattern: Walk Lua statements; track LHS identifiers and TableIndexExpression chains; count chain occurrences (skips sub-expressions of matched chains)

## Entry Points

**Default Export (Plugin Factory):**

- Location: `src/index.ts` line 121
- Triggers: TSTL compiler during plugin loading via `typeof === "function"` check
- Responsibilities: Factory function; creates `OptimizePlugin` instance, returns it
- Signature: `(options?: Record<string, unknown>) => OptimizePlugin`

**Named Export (OptimizePlugin):**

- Location: `src/index.ts` line 124
- Triggers: Direct in-memory instantiation (tests, tooling)
- Responsibilities: Plugin instance; orchestrates rule visitors, participates in TSTL pipeline
- Key methods: `beforeTransform()`, `beforeEmit()`

**Plugin Interface Methods (invoked by TSTL):**

- `beforeTransform(program: ts.Program, options: tstl.CompilerOptions)` — Initializes plugin state, builds merged visitors
- `beforeEmit(program, options, emitHost, result: tstl.EmitFile[])` — Post-processes Lua output (strips comments)
- `visitors: tstl.Visitors` — Property; merged visitor map indexed by SyntaxKind

## Error Handling

**Strategy:** Validation at entry point; no error recovery during transformation

**Patterns:**

- Config parsing validates types, ignores invalid values (e.g., invalid target), falls back to defaults
- Side-effect analysis assumes conservative (returns true on unknown); never throws
- Rule factories assume well-formed input (checker, config already validated); may throw if called with bad data
- Visitor chainers use type assertions safely (each visitor only receives nodes matching its SyntaxKind)

## Cross-Cutting Concerns

**Logging:** None; compiler uses console or TSTL's diagnostic system. Rules can emit diagnostics via `context` but don't currently.

**Validation:**

- Config validation in `parseConfig()` before plugin initialization
- Type checking via TypeScript API (checker parameter)
- No schema validation library used; manual type guards

**Authentication:** N/A (compiler plugin, no external services)

**Rule Priority:**

- Hard-coded order in `RULE_ENTRIES` array (low to high priority)
- Conditional-compilation first (kill dead code before others process)
- Debug-strip last (clean after all optimizations)
- Rules same priority execute in order but don't interact (each checks own conditions)

---

Architecture analysis: 2026-03-26
