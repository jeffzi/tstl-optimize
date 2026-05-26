# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **unspill** rule — folds the redundant base/key temporaries TSTL emits when lowering a compound
  assignment on element/index access (`arr[i] += rhs`). When the cached base and key are
  side-effect-free, the rule replaces the three-local pattern with a direct `arr[i] = arr[i] + rhs`
  assignment. The value-temp form (`return (arr[i] += 5)`) is also handled. Enabled by default;
  disable with `"rules": { "unspill": false }`.
- `tstl-optimize/lua-ast` subpath — exports `unspillStatements` and `isLuaRhsPure` for downstream
  plugins that need to perform the same fold before their own hoisting pass.

## [0.9.0] - 2026-05-20

### Added

- **inline** now supports optional parameters (`param?: T`) without default initializers. Functions
  with optional params inline when all arguments are supplied or when trailing optional arguments
  are omitted (substituted as `nil` in Lua). Arity enforcement rejects excess args and missing
  required args, but allows omitted trailing optionals. Default initializers remain unsupported.
- **inline** now folds computed const expressions during cross-module inlining, including
  arithmetic (e.g., `2 ** BITS`), template literals, and const identifier chains. This
  extends the set of constants that qualify for substitution beyond simple primitive literals.
- **inline** cross-module inlining now permits functions that reference ambient globals (e.g.,
  `Math`, `globalThis`, or any declaration-file symbol) and no longer requires referenced `const`
  literals to be exported. Inlining is still blocked when an ambient name is shadowed by a local
  binding at the call site, preserving runtime semantics.
- **math-intrinsics** now constant-folds `Math.ceil` and `Math.round` at compile time. Adds
  exponentiation strength reduction generalized to `x ** n` (with LuaJIT-specific `x ** 4` →
  `(x * x) * (x * x)`) and division-by-power-of-2 strength reduction (`x / 2` → `x * 0.5`).
- **refold** phase re-runs `constant-folding`, `dead-local`, `merge-locals`, and
  `remove-empty-branch` after all other phases complete, catching cross-rule optimization
  opportunities (e.g., consecutive locals introduced by `localizer` that `merge-locals` can
  combine). Always active; individual rules are still gated by their own `rules.*` toggles.

### Fixed

- **localizer** hoisted chain locals (e.g., `local ____a_columns_x = a.columns.x`) could be
  incorrectly removed by the `dead-local` pass in the refold phase because the synthesized root
  identifier lacked the original variable's `symbolId`, making the read invisible to liveness
  tracking.

## [0.8.0] - 2026-05-09

### Added

- Optimization rules now keep source maps aligned through transforms, so debuggers and stack
  traces point back to the correct TypeScript locations after inlining, hoisting, and rewriting.
  This covers **conditional-compilation**, **loop-rebase**, **math-intrinsics**,
  **remove-empty-branch**, **inline**, and **localizer**.

### Changed

- **inline** now inlines call arguments that are provably evaluated before any side effect
  directly, without wrapping them in an eager temporary. This reduces unnecessary wrapper
  functions in the output.

## [0.7.1] - 2026-04-28

### Fixed

- **inline** preserves call-site binding when inlined function body declares a local with the same name.

## [0.7.0] - 2026-04-27

### Added

- **inline** now substitutes primitive `const` literals during cross-module inlining, so helpers
  that reference exported number, string, or boolean constants can still inline safely.

## [0.6.1] - 2026-04-22

### Changed

- Upgraded to TypeScript 6 and typescript-to-lua 1.36.

## [0.6.0] - 2026-04-21

### Added

- **constant-folding** rule — evaluate constant expressions at compile time.
- **dead-local** rule — eliminate unused local variables.
- **merge-locals** rule — merge local variable declarations with subsequent assignments.
- **remove-empty-branch** rule — drop `if`/`else` branches whose body is empty.

### Fixed

- AST cloning and traversal now preserve call metadata, honor Lua key-before-value table
  evaluation, and treat indexed reads as side-effectful.
- Plugin target inference now refreshes correctly when a plugin instance is reused across different
  Lua targets.
- **conditional-compilation** now handles loose equality and `switch` edge cases, respects shadowed
  configured constants, preserves needed block scopes when folding kept `if` and `switch` branches,
  and stops switch fallthrough after `continue`.
- **debug-strip** now recognizes method-call syntax and matches configured globals by symbol
  identity.
- **inline** now preserves eager argument evaluation for expression-body inlines by hoisting
  side-effecting call arguments, correctly validates side-effects for unused arguments, handles
  cross-module type-only references, variable declaration shadowing, and `export {}` block
  elimination.
- **localizer** now avoids stale chain hoists, shadowed nested-loop array rewrites, and write-only
  array element accesses; hoists chains despite parameter shadowing; hardens config resolution.
- **math-intrinsics** now guards the `Math.floor()` fast path for infinity, avoids unsafe `x ** 2`
  rewrites on indexed bases, and uses proper deep clone for power expressions.

## [0.5.0] - 2026-04-02

### Added

- **inline** rule now supports multi-statement function bodies at statement-level call sites,
  expanding them in-place wrapped in `do...end` blocks. Supported patterns: void statement,
  variable-declaration, return site, and destructuring (object, array, and `LuaMultiReturn`).
- **inline** rule supports per-rule `strict` override (`{ "strict": true }`) to promote inline
  warnings to compilation errors independently of the global setting.

### Changed

- **inline** cross-module rejection is now narrower: only functions that reference non-parameter
  identifiers from the source module are rejected. Previously all multi-statement cross-module
  calls were rejected.
- **inline** now rejects destructuring parameters with a specific diagnostic message instead of
  the generic "parameter symbol could not be resolved".
- **inline** `break` inside `switch` cases is no longer rejected — TSTL compiles switches to
  `if-elseif` chains, so the `break` is scoped to the switch and does not affect the inlined block.

### Fixed

- **inline** expression-body inlining now correctly duplicates complex arguments used multiple times
  in the body. Previously, repeated uses could share internal state and produce corrupted output.
- **localizer** array element write-back is now suppressed when a `return` statement exists inside
  a nested loop. Previously `return` inside nested loops was not detected as an early exit, which
  could cause lost mutations when the write-back was skipped at runtime.

## [0.4.0] - 2026-03-28

### Added

- **inline** rule now supports cross-module `@inline` for self-contained functions whose
  bodies reference only parameters and literals. Functions that capture module-scope variables
  are still rejected with a diagnostic warning.

## [0.3.1] - 2026-03-27

### Fixed

- **localizer** no longer hoists metatable-chaining globals (`assert.are_not.equal`,
  `spy`, `mock`, etc.) that silently break runtime semantics when collapsed into locals.
  The localizer now defaults to hoisting only Lua stdlib roots (`math`, `string`,
  `table`, `os`, `io`, `coroutine`, `bit`, `bit32`, `jit`, `debug`). Use `include` to
  add engine-specific roots (e.g., `["go", "msg", "vmath"]` for Defold) or `["*"]` to
  restore previous behavior. Use `exclude` to remove specific roots.

## [0.3.0] - 2026-03-06

### Added

- **conditional-compilation** rule — strip dead `if`/ternary/`switch` branches and substitute
  compile-time constants resolved from environment variables; emits a diagnostic when a
  condition mixes constants with runtime expressions.

### Fixed

- Multiple optimization rules targeting the same expression now all apply correctly instead of
  only the highest-priority rule firing.

## [0.2.0] - 2026-03-02

### Added

- **debug-strip** rule — remove calls to configurable function names and namespace prefixes
  (e.g., debug or profiling helpers) from Lua output; off by default.

## [0.1.0] - 2026-03-02

### Added

- Plugin infrastructure with configurable rules, target-aware transforms (`puc` / `luajit`
  auto-detected from `luaTarget`), and per-rule enable/disable via tsconfig.
- **math-intrinsics** rule — replace `Math.*` calls with Lua expressions; LuaJIT-aware
  (skips inlining where C function dispatch is already fast).
- **loop-rebase** rule — eliminate `+1` offset in 0-based to 1-based array loops.
- **inline** rule — expand `@inline`-tagged single-expression functions at call sites,
  with side-effect analysis and parameter write detection; emit warnings when inlining
  is skipped and strip `@inline` JSDoc from Lua output.
- **localizer** rule — hoist repeated table access chains (`a.b.c`) to local variables;
  supports both module and function scope, configurable threshold, and array element
  access patterns (`arr[i]`) within loop bodies.
- Cross-platform benchmark runner (Lua 5.1 and LuaJIT) for validating optimizations.
- Runnable examples with generation script.

[Unreleased]: https://github.com/jeffzi/tstl-optimize/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/jeffzi/tstl-optimize/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jeffzi/tstl-optimize/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeffzi/tstl-optimize/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffzi/tstl-optimize/releases/tag/v0.1.0
