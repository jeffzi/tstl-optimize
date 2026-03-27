# tstl-optimize: Localizer Root Filtering

## What This Is

A TSTL compiler plugin that applies optimization rules to TypeScript-to-Lua output. The current
milestone adds root-based filtering to the localizer rule so it only hoists property chains rooted
at known-safe globals, protecting against metatable-chaining libraries where hoisting silently
breaks runtime semantics.

## Core Value

The localizer must never silently change program behavior. Safe by default — users opt in to
additional optimizations, not out of broken ones.

## Requirements

### Validated

- ✓ Localizer hoists repeated property chains into locals — existing
- ✓ Configurable threshold and scope (module/function/all) — existing
- ✓ Array element localization in loops — existing
- ✓ Guard-depth tracking prevents hoisting from conditional contexts — existing
- ✓ Locally-defined base detection prevents hoisting above definitions — existing
- ✓ Six optimization rules with per-rule enable/disable — existing

### Active

- [ ] Default to opt-in: only hoist chains rooted at Lua stdlib globals
- [ ] `includeRoots: string[]` config to add user-declared safe roots
- [ ] `excludeRoots: string[]` config to remove specific roots
- [ ] Wildcard `"*"` in includeRoots enables all roots (opt-out mode)
- [ ] Internal blocklist of known metatable-chaining globals (busted/luassert)
- [ ] `includeRoots` overrides internal blocklist (explicit user choice)
- [ ] Resolution: `(STDLIB ∪ includeRoots) \ excludeRoots \ (BLOCKLIST \ includeRoots)`
- [ ] Existing tests updated for new default behavior
- [ ] New tests cover all config combinations
- [ ] README documents the new config options

### Out of Scope

- TS type-based metatable detection — TS declarations don't encode metamethod behavior
- Depth-based chain limits (maxDepth) — too blunt, breaks legitimate deep chains like
  `config.graphics.width`; can be layered on later if needed
- Per-chain opt-out annotations — over-engineering for the problem size

## Context

The bug was found while adding tstl-optimize to ecstatic's test-runtime tsconfig. The localizer
hoisted `assert.are_not.equal` into a module-level local, collapsing the metatable `__index` chain
and losing the negation flag. Tests passed but with silently wrong semantics (`assert.are.equal`
behavior instead of `assert.are_not.equal`).

The TSTL ecosystem targets game engines (Defold, LÖVE, WoW, MA Lighting) where APIs are
overwhelmingly flat function tables — safe to hoist. Metatable chaining is the exception
(busted/luassert, middleclass, penlight). The design reflects this: stdlib-safe default with
easy opt-in for engine APIs (`includeRoots: ["go", "msg", "vmath"]` for Defold, or `"*"` for
everything).

### Hardcoded sets

**STDLIB_ROOTS:** `math`, `string`, `table`, `os`, `io`, `coroutine`, `bit`, `bit32`, `jit`,
`debug`

**INTERNAL_BLOCKLIST:** `assert`, `spy`, `stub`, `mock`, `describe`, `it`, `pending`, `setup`,
`teardown`, `before_each`, `after_each`, `insist`

## Constraints

- **Backward compatibility**: Changing the default from "hoist everything" to "stdlib only" is a
  breaking change for users who rely on hoisting of non-stdlib chains. This is the correct
  direction (safety over performance) but needs a CHANGELOG entry and semver bump.
- **Tech stack**: TypeScript plugin operating on post-transpile Lua AST — no type information
  available at the point where hoisting decisions are made.
- **Test infrastructure**: Tests use `compile()` helper that transpiles TS → Lua via
  `tstl.transpileVirtualProject` with the plugin active. All assertions are on Lua output strings.

## Key Decisions

| Decision                             | Rationale                                                                                        | Outcome   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | --------- |
| Opt-in default (stdlib only)         | Safety over performance — users shouldn't need to discover `excludeRoots` after a production bug | — Pending |
| `"*"` wildcard for opt-out mode      | Avoids a separate `mode` config field; composes naturally with `excludeRoots`                    | — Pending |
| Internal blocklist always active     | Known-bad roots should never be hoisted unless user explicitly overrides via `includeRoots`      | — Pending |
| Breaking change (semver minor→major) | Default behavior changes; existing non-stdlib chains stop being hoisted                          | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

Last updated: 2026-03-27 after initialization
