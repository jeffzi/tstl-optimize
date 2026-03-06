# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-03-06

### Added

- **conditional-compilation** rule — strip dead `if`/ternary/`switch` branches and substitute
  compile-time constants resolved from environment variables; emits a diagnostic when a
  condition mixes constants with runtime expressions

### Fixed

- Expression visitors from different rules now chain correctly instead of the higher-priority
  visitor shadowing lower-priority ones

## [0.2.0] - 2026-03-02

### Added

- **debug-strip** rule — remove calls to configurable function names and namespace prefixes
  (e.g. debug/profiling helpers) from Lua output; off by default

## [0.1.0] - 2026-03-02

### Added

- Plugin infrastructure with configurable rules, target-aware transforms (`puc` / `luajit`
  auto-detected from `luaTarget`), and per-rule enable/disable via tsconfig
- **math-intrinsics** rule — replace `Math.*` calls with Lua expressions; LuaJIT-aware
  (skips inlining where C function dispatch is already fast)
- **loop-rebase** rule — eliminate `+1` offset in 0-based to 1-based array loops
- **inline** rule — expand `@inline`-tagged single-expression functions at call sites,
  with side-effect analysis and parameter write detection; emit warnings when inlining
  is skipped and strip `@inline` JSDoc from Lua output
- **localizer** rule — hoist repeated table access chains (`a.b.c`) to local variables;
  supports both module and function scope, configurable threshold, and array element
  access patterns (`arr[i]`) within loop bodies
- Cross-platform benchmark runner (Lua 5.1 and LuaJIT) for validating optimizations
- Runnable examples with generation script

[Unreleased]: https://github.com/jeffzi/tstl-optimize/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/tstl-optimize/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffzi/tstl-optimize/releases/tag/v0.1.0
