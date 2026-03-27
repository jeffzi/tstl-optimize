# Technology Stack

**Analysis Date:** 2026-03-26

## Languages

**Primary:**

- TypeScript 5.9.0 - Plugin development and source transformation logic
- JavaScript (ES2022) - Build scripts and tooling

**Secondary:**

- Lua - Target language for TypeScript-to-Lua compilation (plugin optimizes Lua output)
- YAML - CI/CD workflows and configuration
- JSON - Configuration and manifest files
- Markdown - Documentation

## Runtime

**Environment:**

- Node.js LTS (lts/* in CI, v25.8.2 locally)

**Package Manager:**

- npm 11.11.1
- Lockfile: package-lock.json (present)

## Frameworks

**Core:**

- TypeScript-to-Lua (TSTL) 1.33.0 - Peer dependency; this project is a plugin for TSTL
  - Provides plugin interface: `tstl.Plugin`, `tstl.Visitors`, `tstl.TransformationContext`
  - Core compiler for transforming TypeScript to Lua

**Testing:**

- Vitest 4.0.0 - Unit test runner
  - Config: `vitest.config.ts`
  - Coverage provider: v8
  - Thresholds: 90% across lines, functions, branches, statements

**Build/Dev:**

- TypeScript 5.9.0 - Transpilation to ES2022 CommonJS
  - Config: `tsconfig.plugin.json` (ES2022 target, strict mode)
- Biome 2.4.0 - Code formatting and linting (replaces ESLint/Prettier)
  - Linter and formatter unified
  - Line width: 100, indent: 2 spaces, double quotes, semicolons
- esbuild/rollup - Not explicit; distributed as CommonJS (tsc output)

## Key Dependencies

**Critical:**

- ts-api-utils 2.4.0 - TypeScript compiler API utilities
  - Used in `src/rules/inline.ts` for access kind analysis
  - Used in `src/ast/ts-ast.ts` for assignment kind detection
- typescript-to-lua 1.33.0 - Peernode; TSTL compiler framework

**Development Infrastructure:**

- @commitlint/cli 20.4.0 - Enforce conventional commits
  - Config: `.commitlintrc.json` (extends conventional config)
- @commitlint/config-conventional 20.4.0 - Conventional commit presets
- lefthook 2.1.0 - Git hooks manager (installed in `prepare` script)
  - Config: `lefthook.yml` with pre-commit, commit-msg, pre-push hooks
- knip 5.85.0 - Dead code detection
  - Config: `knip.json`
  - Ignores: `@commitlint/cli`, `@typescript-to-lua/language-extensions`, `dprint`
- @vitest/coverage-v8 4.0.0 - Code coverage with v8 provider
- markdownlint-cli2 0.21.0 - Markdown linting
- dprint 0.52.0 - Markdown formatting
- lua-types 2.13.0 - Lua type definitions for TypeScript
- luamark-types (from github:jeffzi/luamark#ts-types) - TypeScript types for luamark
- @types/node 25.3.0 - Node.js type definitions

## Configuration

**Environment:**

- `.env` file present - Contains runtime configuration (content not exposed)
- `.env.example` available - Template for required environment variables
- No external service credentials detected in source code

**Build:**

- `tsconfig.plugin.json` - Targets ES2022, CommonJS, strict type checking
- `vitest.config.ts` - Test runner configuration with coverage thresholds
- `biome.json` - Unified linting and formatting rules
- `lefthook.yml` - Pre-commit, commit-msg, and pre-push hooks
- `.commitlintrc.json` - Conventional commit validation

## Platform Requirements

**Development:**

- Node.js LTS
- npm 11.11.1+
- Git (for lefthook pre-commit hooks)
- Optional: go-task for `task bench` commands (Taskfile.yml)

**Production:**

- Node.js LTS (plugin distributed as CommonJS)
- TypeScript-to-Lua 1.22.0+ (peer dependency)
- Published to npm registry as `tstl-optimize`
- Entry points:
  - CommonJS: `dist/index.js`
  - Types: `dist/index.d.ts`

## Distribution

**Package Metadata:**

- Name: `tstl-optimize`
- Version: 0.3.0
- Main: `dist/index.js`
- Types: `dist/index.d.ts`
- Files included: `dist/` only
- Published to npm via GitHub Actions (Release workflow on git tags)

**Build Process:**

- TypeScript compilation to `dist/` folder
- `prepare` script runs `npm run build` for git dependency installs
- `prepack` script ensures build before npm publish

---

Stack analysis: 2026-03-26
