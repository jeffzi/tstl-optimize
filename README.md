# tstl-plugin-template

[![CI](https://github.com/jeffzi/tstl-plugin-template/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffzi/tstl-plugin-template/actions/workflows/ci.yml)
[![Biome](https://img.shields.io/badge/checked_with-biome-60a5fa.svg)](https://biomejs.dev)
[![Vitest](https://img.shields.io/badge/tested_with-vitest-6e9f18.svg)](https://vitest.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A GitHub template for [TypeScriptToLua](https://typescripttolua.github.io/) plugins.

## What's included

- **TypeScript** with strict mode, targeting ES2022
- **Biome** for linting and formatting
- **Vitest** for testing with V8 coverage (90% threshold)
- **Knip** for detecting unused exports and dependencies
- **Lefthook** for Git hooks
- **markdownlint** for Markdown linting
- **GitHub Actions CI** running checks, typecheck, build, and tests
- **Dependabot** for automated dependency updates

## Getting started

1. Click **Use this template** on GitHub to create a new repository.
2. Update `name` and `description` in `package.json`.
3. Run `npm install`.
4. Add your plugin source under `src/` (entry point: `src/index.ts`).
5. Add tests under `test/` (pattern: `test/**/*.test.ts`).

## Scripts

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `npm run build`      | Compile TypeScript                   |
| `npm run test`       | Run tests                            |
| `npm run check`      | Lint and format with Biome           |
| `npm run check:fix`  | Auto-fix lint and format issues      |
| `npm run check:md`   | Lint Markdown files                  |
| `npm run check:unused` | Detect unused code with Knip       |
| `npm run typecheck`  | Type-check without emitting          |
| `npm run validate`   | Run check + typecheck + unused       |

## License

[MIT](LICENSE)
