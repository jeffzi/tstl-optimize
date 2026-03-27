# External Integrations

**Analysis Date:** 2026-03-26

## APIs & External Services

**None detected** - This project is a standalone TSTL plugin with no external API calls.

The plugin processes TypeScript source code and generates optimization transformations; all processing is in-memory and file-based.

## Data Storage

**Databases:**

- None - Project does not use databases

**File Storage:**

- Local filesystem only
  - Input: TypeScript source files
  - Output: Transformed Lua code via TSTL compiler
  - Cache: `.conformance/` directory for conformance test cloning (git-cached)

**Caching:**

- GitHub Actions cache for conformance tests
  - Key: `conformance-${{ hashFiles('scripts/conformance.mjs', 'scripts/conformance.patch') }}`
  - Path: `.conformance`

## Authentication & Identity

**Auth Provider:**

- None - No authentication layer
- GitHub Actions uses standard checkout and setup-node actions (read-only access)

## Monitoring & Observability

**Error Tracking:**

- None detected

**Logs:**

- Console output only
- Biome linter warns on `console.` calls (lint rule: `suspicious/noConsole`)
- Test output to console via Vitest

## CI/CD & Deployment

**Hosting:**

- npm Registry (GitHub Actions publishes on tag push)

**CI Pipeline:**

- GitHub Actions
  - Workflow: `.github/workflows/ci.yml`
  - Trigger: Push to `main` and pull requests
  - Steps:
    1. Checkout code (actions/checkout@v6)
    2. Setup Node.js LTS (actions/setup-node@v6, caches npm)
    3. Install dependencies (npm ci)
    4. Lint and format check (npm run check)
    5. Markdown linting (npm run check:md)
    6. TypeScript type checking (npm run typecheck)
    7. Unused code detection (npm run check:unused)
    8. Build compilation (npm run build)
    9. Unit tests with coverage (npm run test)
    10. Cache conformance tests (actions/cache@v4)
    11. Check examples consistency (npm run examples:check)
    12. Run conformance tests (npm run test:conformance)

**Release Pipeline:**

- Workflow: `.github/workflows/release.yml`
- Trigger: Tag push (any `*` tag)
- Publishes to npm registry via `npm publish`
- Uses OIDC (id-token: write) for npm authentication (no static tokens)

**Dependabot:**

- Config: `.github/dependabot.yml`
- Package ecosystem: npm (weekly updates)
- GitHub Actions (weekly updates)
- Patch updates ignored (only minor/major tracked)
- Commit prefix: `build(deps)`

## Environment Configuration

**Required env vars:**

- `.env` file present but no external service credentials detected
- Environment variables not exposed in source code
- Configuration loaded via TypeScript plugin options (type: `PluginConfig`)

**Secrets location:**

- GitHub Actions secrets: OIDC token for npm publish (id-token)
- No hardcoded secrets in repository

## Webhooks & Callbacks

**Incoming:**

- None detected

**Outgoing:**

- GitHub Actions on test failure/success (implicit in workflow)
- Dependabot creates pull requests automatically

## Local Development Integrations

**Git Hooks:**

- Pre-commit (lefthook):
  - Biome check/format TypeScript/JS/JSON files
  - dprint format Markdown files
  - markdownlint-cli2 lint Markdown files
  - TypeScript type checking
  - knip unused code detection
  - actionlint check GitHub workflows

- Commit-msg (lefthook):
  - commitlint validates conventional commit format

- Pre-push (lefthook):
  - Build compilation
  - Full test suite (unit + conformance)
  - Examples consistency check

**Task Automation:**

- go-task (optional)
  - `task bench` - Run Lua 5.1/LuaJIT benchmarks
  - Dependencies on build task
  - Executes `scripts/bench.mjs` with filtering

## Third-Party Type Definitions

**Provided by:**

- lua-types 2.13.0 - Lua standard library types
- @types/node 25.3.0 - Node.js built-in types
- luamark-types (custom) - TypeScript-to-Lua plugin types

## Conformance Testing

**External TSTL Repository:**

- Tests against TypeScript-to-Lua conformance suite
- Location: `.conformance/` (git-cloned, GitHub Actions cached)
- Script: `scripts/conformance.mjs` with optional patch file
- No network calls during tests; cached locally

## Example Generation

**Conformance with Examples:**

- Examples directory: `examples/`
- Consistency check: `npm run examples:check`
- Validates that examples generate expected output
- No external generation services

---

Integration audit: 2026-03-26
