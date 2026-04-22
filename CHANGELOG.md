# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-04-22

### Changed

- Upgraded to TypeScript 6 and typescript-to-lua 1.36.

## [0.6.0] - 2026-04-21

### Added

- **constant-folding** rule — evaluate constant expressions at compile time.
- **dead-local** rule — eliminate unused local variables.
- **merge-locals** rule — merge local variable declarations with subsequent assignments.
- **remove-empty-branch** rule — drop `if`/`else` branches whose body is empty.
- **debug-strip** rule now includes `console` in its default namespaces.

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
  (e.g. debug/profiling helpers) from Lua output; off by default.

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

[Unreleased]: https://github.com/jeffzi/tstl-optimize/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/jeffzi/tstl-optimize/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeffzi/tstl-optimize/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffzi/tstl-optimize/releases/tag/v0.1.0
