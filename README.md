# tstl-optimize

[![CI](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [TypeScriptToLua](https://typescripttolua.github.io/) compiler plugin that rewrites the generated
Lua for better runtime performance — fewer table lookups, smaller closures, and tighter loops.

```typescript
// TypeScript input
Math.sqrt(x)
math.floor(a) + math.floor(b)
/** @inline */
function double(x: number) {
  return x * 2;
}
const y = double(5);
```

```lua
-- Lua output (with plugin)
x ^ 0.5
local ____math_floor = math.floor
____math_floor(a) + ____math_floor(b)
-- (inlined at call sites)
local y = 5 * 2
```

Primary targets are **Lua 5.1 (PUC-Rio)** and **LuaJIT**. Other TSTL targets (5.2–5.4) compile
without errors but are not specifically tuned — treat optimizations as best-effort on those targets.
Every rule is independently toggleable. All rules are on by default **except**
`conditional-compilation` and `debug-strip`, which remove code.

## Contents

- [Installation](#installation)
- [Usage](#usage)
- [Recommended usage](#recommended-usage)
- [Rules](#rules)
- [Strict mode](#strict-mode)
- [Configuration reference](#configuration-reference)
- [Examples](#examples)
- [Benchmarks](#benchmarks)
- [FAQ](#faq)
- [License](#license)

Rule reference:

- [`conditional-compilation`](#conditional-compilation)
- [`constant-folding`](#constant-folding)
- [`math-intrinsics`](#math-intrinsics)
- [`dead-local`](#dead-local)
- [`merge-locals`](#merge-locals)
- [`remove-empty-branch`](#remove-empty-branch)
- [`loop-rebase`](#loop-rebase)
- [`inline`](#inline)
- [`localizer`](#localizer)
- [`debug-strip`](#debug-strip)

## Installation

```bash
npm install --save-dev typescript-to-lua tstl-optimize
```

Requires `typescript-to-lua >= 1.22.0`; tested against `1.36.0`.

## Usage

A minimal working `tsconfig.json` follows. The plugin auto-detects `target` from `luaTarget`:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "outDir": "./lua",
    "types": ["@typescript-to-lua/language-extensions", "lua-types/5.1"],
    "plugins": [{ "name": "tstl-optimize" }]
  },
  "tstl": {
    "luaTarget": "5.1"
  },
  "include": ["src/**/*"]
}
```

Then compile:

```bash
npx tstl -p tsconfig.json
```

To customize rules:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "rules": {
          "math-intrinsics": true,
          "loop-rebase": true,
          "inline": true,
          "localizer": { "threshold": 3, "scope": "function" },
          "debug-strip": { "functions": ["print", "assert"], "namespaces": ["debug"] }
        },
        // Optional: auto-detected from luaTarget when omitted
        "target": "puc" // or "luajit"
      }
    ]
  }
}
```

## Recommended usage

Use the rules in two groups:

- **Build specialization:** `conditional-compilation`, `debug-strip`
- **Performance optimization:** `constant-folding`, `dead-local`, `merge-locals`, `localizer`,
  `loop-rebase`, `inline`, `math-intrinsics`, `remove-empty-branch`

`conditional-compilation` and `debug-strip` are useful even when raw speed is not the main goal.
Lua has no native preprocessor, so these rules let you remove platform-specific branches, debug
logging, and development-only helpers at build time.

For most projects, start with a conservative profile and then enable more aggressive rules only for
known hot paths or release builds.

### Safe default

This profile keeps the low-risk cleanup rules enabled, treats build specialization as explicit, and
avoids relying on aggressive call-site rewrites everywhere:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "strict": true,
        "rules": {
          "constant-folding": true,
          "dead-local": true,
          "merge-locals": true,
          "remove-empty-branch": true,
          "localizer": { "scope": "function", "threshold": 2 },
          "loop-rebase": true,
          "inline": false,
          "math-intrinsics": true,
          "conditional-compilation": false,
          "debug-strip": false
        }
      }
    ]
  }
}
```

Use this when you want predictable output and only opt into code-removal rules in dedicated build
configs.

### Release build with specialization

This profile is better for projects that need platform-specific code and log stripping:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "strict": true,
        "rules": {
          "constant-folding": true,
          "dead-local": true,
          "merge-locals": true,
          "remove-empty-branch": true,
          "localizer": { "scope": "function", "threshold": 2 },
          "loop-rebase": true,
          "inline": true,
          "math-intrinsics": true,
          "conditional-compilation": {
            "strict": true,
            "constants": {
              "DEBUG": { "env": "DEBUG", "default": false },
              "PLATFORM": { "env": "PLATFORM", "default": "desktop" }
            }
          },
          "debug-strip": {
            "functions": ["print", "assert"],
            "namespaces": ["debug"]
          }
        }
      }
    ]
  }
}
```

### Rule selection notes

- Prefer `conditional-compilation` for platform gates, feature flags, and dev/prod branches.
- Prefer `debug-strip` for release builds that should remove logs, tracing, and profiling calls.
- Use `inline` on hot paths and allocation-heavy helpers, not as a blanket annotation strategy.
- Measure `math-intrinsics` on your target interpreter. Some rewrites help on PUC-Rio Lua, some are
  neutral, and LuaJIT may prefer the built-in C calls.
- Keep separate dev and release configs when you enable code-removal rules.

## Rules

The sections below cover every supported rule and the configuration key that enables it.

### `conditional-compilation`

Evaluates compile-time constants and strips dead branches from `if`/ternary/`switch` statements.
**Off by default** — enable it with a constants map binding each identifier to an environment
variable and a default value.

Each constant must be declared in TypeScript as `declare const NAME: T;` so the compiler treats it
as ambient (no runtime binding). The plugin substitutes these identifiers with literals; without
the `declare const`, TSTL would emit real variable declarations that override the substitution.

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "rules": {
          "conditional-compilation": {
            "constants": {
              "DEBUG": { "env": "DEBUG", "default": false },
              "PLATFORM": { "env": "PLATFORM", "default": "desktop" },
              "LOG_LEVEL": { "env": "LOG_LEVEL", "default": 0 }
            }
          }
        }
      }
    ]
  }
}
```

```typescript
// Branch folding — the rule strips dead branches entirely
if (DEBUG) { print("debug info"); }          // stripped (DEBUG is false)
const label = PLATFORM === "web" ? "W" : "D"; // folds to "D"

// Switch — only the matching case survives
switch (PLATFORM) {
  case "web": setupWeb(); break;      // stripped
  case "desktop": setupDesktop(); break; // kept
}

// Expression substitution — the rule replaces constants with literals everywhere
const isDebug = DEBUG;                // becomes: isDebug = false
const isWeb = PLATFORM === "web";     // becomes: isWeb = false
```

At build time, the rule reads the environment variable named in `env` and falls back to `default`
when the variable is unset. Supported value types: `boolean`, `number`, `string`.

Beyond branch elimination, the rule **substitutes every constant reference with its literal value**
in any expression context. This matters because `declare const` identifiers lack a runtime
definition — without substitution they would appear as undefined globals in the Lua output. The rule
replaces bare identifiers (`DEBUG`), binary comparisons (`PLATFORM === "web"`), and negations
(`!DEBUG`) with their resolved literals wherever they appear.

**Limitations:**

- **Name-based matching** — matches bare identifiers, not TS types. A local variable that shadows a
  constant name will also be substituted.
- **Partial conditions emit a warning** — when a condition mixes compile-time constants with runtime
  variables (e.g., `PLATFORM === "desktop" && connected`), the rule cannot fold the branch and emits
  a diagnostic warning (code 90002).
- **Supported operators** — `===`, `!==`, `&&`, `||`, `!` in conditions. The rule does not evaluate
  other operators (e.g., `<`, `+`).

### `constant-folding`

Evaluates side-effect-free constant expressions after TypeScriptToLua lowers the file to Lua. The
rule runs repeated bottom-up passes until the output stops changing, so nested constant
subexpressions collapse without relying on source order.

```typescript
const nested = (1 + 2) * (3 + 4);
const eq = (10 as number) === 10;
const greeting = "hello" + " " + "world";
```

```lua
local nested = 21
local eq = true
local greeting = "hello world"
```

**Limitations:**

- Folds only side-effect-free constant subexpressions.
- Skips results that cannot be written as Lua literals, such as `1 / 0`.
- Leaves mixed runtime expressions like `x + 1` alone unless a nested constant subexpression stands
  on its own.

### `math-intrinsics`

Replaces `Math.*` calls and arithmetic patterns with inline Lua expressions. Call-expression
rewrites (`Math.sqrt`, `Math.floor`, etc.) skip LuaJIT targets, which already handle C calls
efficiently. Binary-expression rewrites (`**`, `/`) run on all targets unless noted otherwise.

| Source | Lua output | Notes |
| --- | --- | --- |
| `Math.sqrt(x)` | `x ^ 0.5` | Lossless |
| `Math.floor(x)` | `(x == math.huge or x == -math.huge) and math.floor(x) or x - x % 1` | Lossless; guard preserves `math.huge` for ±∞ inputs |
| `Math.ceil(n)` | Literal folded (e.g. `Math.ceil(1.5)` → `2`) | Numeric-literal argument only; non-literal falls through |
| `Math.round(n)` | Literal folded (e.g. `Math.round(1.5)` → `2`) | Numeric-literal argument only; non-literal falls through |
| `Math.abs(x)` | `(x == 0) and 0 or ((x < 0) and -x or x)` | Lossless; zero-check preserves `+0` for `-0` input |
| `Math.max(1, 2)` | `(1 > 2) and 1 or 2` | 2-arg, numeric literals only |
| `Math.min(1, 2)` | `(1 < 2) and 1 or 2` | 2-arg, numeric literals only |
| `x ** 2` | `x * x` | Lossless |
| `x ** 3` | `(x * x) * x` | Lossless |
| `x ** 4` | `(x * x) * (x * x)` | LuaJIT only; PUC-Rio keeps `^` (C `pow` is faster than 3 MULs) |
| `x / n` (power of 2) | `x * (1/n)` | e.g. `x / 4` → `x * 0.25`; positive power-of-2 divisor only |

*Lossless: the rewrite produces bit-identical results to the original call for all finite inputs.*

`abs` and `floor` rewrite only side-effect-free arguments, so duplicating them is safe. `ceil` and
`round` fold only when the argument is a numeric literal — non-literal arguments pass through to
`math.ceil` / `math.round`. `max` and `min` rewrite only when **both** arguments are numeric
literals, which — combined with `constant-folding` — collapses the pattern at compile time;
non-literal arguments fall through to `math.max` / `math.min`.

> **Edge cases:** `x ** n` and `x / n` rewrites assume `x` is numeric; they skip non-numeric
> operands where `__mul`, `__pow`, and `__div` metamethods could produce different results. If you
> rely on operator-overloaded arithmetic, disable this rule.

### `dead-local`

Removes unused single-name local declarations inside function bodies when the initializer is pure.
If the variable is overwritten before any read, the rule keeps the local and drops only the
initializer.

```typescript
function pureUnused(): number {
  const dead = 42;
  const live = 10;
  return live;
}
```

```lua
local function pureUnused()
  local live = 10
  return live
end
```

**Limitations:**

- Applies only inside function bodies; module-scope locals are preserved.
- Keeps declarations whose initializer may have side effects.
- Skips multi-variable locals such as destructuring that lowers to `local a, b = ...`.

### `merge-locals`

Merges consecutive single-name local declarations into one Lua `local` statement when every
initializer in the run is pure and the merged assignment preserves capture semantics.

```lua
-- Before
local a = 1
local b = 2
local c = 3

-- After
local a, b, c = 1, 2, 3
```

**Limitations:**

- Stops before an initializer that reads an earlier local in the same run.
- Stops before closures that would capture a variable before the merged assignment binds it.
- Applies only inside function bodies; module-scope locals are left as written.

### `remove-empty-branch`

Removes empty `if`/`elseif`/`else` branches and promotes a non-empty `else` block when the empty
`if` branch can be inverted safely. The rule also removes fully empty chains when their conditions
are safe to read.

```lua
-- Before
if x then
else
  doSomething()
end

-- After
if not x then
  doSomething()
end
```

**Limitations:**

- The rule removes a condition only when the truthiness check has no side effects and cannot trigger
  metamethods.
- Non-empty branches are left alone unless the rule is inverting an empty `if` with a plain `else`.
- Branches with side-effecting conditions such as function calls are preserved.

### `loop-rebase`

Converts 0-based `$range` for-of loops into 1-based Lua for loops. TSTL emits `i + 1` in Lua
wherever TypeScript uses `i` to index a 1-based array; the rule eliminates that per-iteration
arithmetic by shifting the loop bounds up by one instead.

```typescript
// Input
for (const i of $range(0, n - 1)) {
  arr[i] = value;
}
```

```lua
-- Before: for i = 0, n - 1 do arr[i + 1] = value end
-- After:  for i = 1, n do arr[i] = value end
```

The rule skips the loop when the body assigns the control variable, reads it without an accompanying `+ 1` offset (rebasing would produce a wrong index), or shadows it in a nested declaration.

### `inline`

Inlines `@inline`-tagged functions at call sites, both within the same module and across module boundaries. Pass `false` or `{ enabled: false }` to disable; pass `{ strict: false }` to keep the rule active but downgrade its diagnostics to warnings (see [Strict mode](#strict-mode)).

```typescript
/** @inline */
function double(x: number) {
  return x * 2;
}
const y = double(5); // becomes: const y = 5 * 2
```

> **Source map caveat:** The `inline` rule currently has limited debugger support. Because the
> original `@inline` function body is removed and emitted at each call site, breakpoints set inside
> the original function body may not resolve. Some debuggers, including
> [Local Lua Debugger for VS Code](https://github.com/tomblind/local-lua-debugger-vscode), can
> error instead of moving the breakpoint to a mapped line. For debugging, set breakpoints at call
> sites or disable `rules.inline` in your debug config.

Cross-module inlining works for self-contained functions that only reference parameters and
literals. The rule skips functions that capture module-scope variables and emits a diagnostic
warning (code 90003).

```typescript
// utils.ts
/** @inline */
export function double(x: number) { return x * 2; }       // ✓ OK
/** @inline */
export function addOffset(x: number) { return x + OFFSET; } // ✗ captures OFFSET

// main.ts
import { double } from "./utils";
const y = double(5); // inlined: const y = 5 * 2
```

A function must meet these conditions to be inlined:

- `@inline` JSDoc tag on the function
- Single-expression body (or arrow `=> expr`) or supported multi-statement body
- Module-scope function (not nested)
- No rest, default, optional, or destructuring parameters
- Non-recursive
- No parameter writes inside the body
- Multi-use parameters require side-effect-free arguments in expression bodies
- Cross-module: body references only parameters and literals (no captured variables from the same module)

#### Multi-statement inline

The plugin supports multi-statement function bodies at statement-level call sites. It expands these in-place, wrapping them in a `do...end` block (except at return sites) to keep declared variables from escaping into the caller's scope.

#### Pattern 1 — void statement site

```typescript
/** @inline */
function setup(x: number) {
  let a = x + 1;
  console.log(a);
}
declare const n: number;
setup(n); // expanded into do...end block
```

```lua
local ____inline_arg_0 = n
do
  local a = ____inline_arg_0 + 1
  print(a)
end
```

#### Pattern 2 — variable-declaration site

```typescript
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}
declare const a: number;
const r = compute(a);
```

```lua
local r
local ____inline_arg_0 = a
do
  local y = ____inline_arg_0 + 1
  r = y * 2
end
```

#### Pattern 3 — return site

```typescript
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}
declare const a: number;
function caller(): number {
  return compute(a);
}
```

```lua
-- body statements emitted flat, no do...end needed
local ____inline_arg_0 = a
local y = ____inline_arg_0 + 1
return y * 2
```

#### Pattern 4 — destructuring site

```typescript
/** @inline */
function foo(x: number): { a: number; b: number } {
  const obj = { a: x, b: x + 1 };
  return obj;
}
declare const x: number;
const { a, b } = foo(x);
```

```lua
-- result variable holds the inlined return, bindings extracted after do...end
local ____inline_result_N
local ____inline_arg_0 = x
do
  local obj = {a = ____inline_arg_0, b = ____inline_arg_0 + 1}
  ____inline_result_N = obj
end
local a = ____inline_result_N.a
local b = ____inline_result_N.b
```

(where `N` is a compiler-generated symbol ID; the exact value is unimportant)

#### Pattern 5 — LuaMultiReturn destructuring site

```typescript
/** @inline */
function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
  const tmp = a;
  return $multi(b, tmp);
}
declare const x: number;
declare const y: number;
const [p, q] = swap(x, y);
```

```lua
local ____inline_result_A
local ____inline_result_B
local ____inline_arg_0 = x
local ____inline_arg_1 = y
do
  local tmp = ____inline_arg_0
  ____inline_result_A, ____inline_result_B = ____inline_arg_1, tmp
end
local p, q = ____inline_result_A, ____inline_result_B
```

Multiple result variables are allocated to capture all return values. A single variable would
truncate multi-return to its first value in Lua.

Argument temporaries are always hoisted before the `do...end` block to preserve the left-to-right
evaluation order of the original call's arguments. Variables declared inside `do...end` do not leak
into the caller's scope.

A multi-statement `@inline` function with an empty body is removed at statement sites without
emitting a diagnostic. No `do...end` block is generated.

#### Call-site limitations

Multi-statement inline is rejected with a diagnostic warning (code 90010) at expression positions
where the result feeds another expression. The function declaration is kept and the call is left
unchanged:

```typescript
// Not inlined — expression position
const r = effect(a) + 1;   // warns: multi-statement body cannot be inlined at expression position
bar(effect(a));             // warns: multi-statement body cannot be inlined at expression position
```

Functions with an early `return`, `break`, or `continue` in the body are also rejected — Lua's
`do...end` block has no "return from block" construct, so a `return` inside the inlined body would
return from the enclosing function rather than just exiting the inline. `break` inside a `switch` or
loop is allowed (it is scoped to that construct and does not affect the inlined block):

```typescript
/** @inline */
function bail(x: number) { if (x > 0) return; console.log(x); }
declare const n: number;
bail(n); // warns: @inline ignored — early return in body
```

#### Rule interaction

Subsequent rules in the pipeline process inlined `do...end` blocks. For example, if an inlined
body calls `Math.floor(x)` multiple times, the `localizer` rule hoists a `____math_floor` local as
it would for hand-written code. `math-intrinsics` rewrites `Math.*` calls inside inlined bodies the
same way. Rules apply to the fully expanded output, so inlined code receives the same optimizations
as the rest of the file.

### `localizer`

Hoists repeated table-index chains (e.g., `math.floor`, `game.players.count`) into local variables
at the top of the scope. Inside loop bodies, the rule also localizes repeated `arr[i]` accesses
(where `i` is the loop control variable) and appends a write-back when the element is assigned.

```lua
-- Static chain hoisting
-- Before                          -- After
math.floor(x)                      local ____math_floor = math.floor
math.floor(y)                      ____math_floor(x)
                                   ____math_floor(y)

-- Array element localization (loop bodies)
-- Before                          -- After
for i = 1, n do                    for i = 1, n do
    vel[i] = vel[i] * friction         local ____vel = vel[i]
    pos[i] = pos[i] + vel[i] * dt      ____vel = ____vel * friction
end                                    pos[i] = pos[i] + ____vel * dt
                                       vel[i] = ____vel
                                   end
```

Array element localization handles the simple case only:

- The base must be a plain identifier and the index must match the loop control variable exactly.
- Loops containing function calls are skipped — a call could modify the array through a reference,
  making the cached local stale.
- Write-back candidates in loops with early exits (`break`/`return`) are skipped.

Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | `2` | Minimum read-count before hoisting |
| `scope` | `"module" \| "function" \| "all"` | `"all"` | Where the rule hoists locals |
| `include` | `string[]` | `[]` | Additional root globals to hoist alongside stdlib. Use `["*"]` to allow all roots (opt-out mode). Explicit entries override the internal blocklist. |
| `exclude` | `string[]` | `[]` | Root globals to block from hoisting, even if in stdlib or `include`. |

#### Scope modes

- `module`: Run only the module-level pass. Hoists are emitted at file scope, not inside functions.
  This mode counts stdlib chains that appear inside nested functions. For non-stdlib roots added via
  `include`, the chain must also be read at module scope to be hoisted — this avoids snapshotting a
  mutable global once at load time and reusing a stale value across later function calls.
- `function`: Skip module hoisting and only localize inside function bodies, guarded blocks, and
  loop bodies. This is useful when you want caching close to the reads instead of at file scope.
- `all`: Default. Run the module-level pass first, then run the function-body pass for chains that
  were not already hoisted at module scope. This avoids duplicate hoists while still allowing
  function-local caching for chains that cannot safely move to module scope.

#### Root filtering

##### Default behavior

The localizer hoists only chains rooted at Lua stdlib globals by default:
`math`, `string`, `table`, `os`, `io`, `coroutine`, `bit`, `bit32`, `jit`, `debug`.

Chains rooted at any other global are skipped. This protects against libraries that rely on
metatables (e.g., busted/luassert: `assert.are_not.equal`), where hoisting the chain would
collapse the `__index` chain and silently change behavior.

**Resolution formula** (`∪` = union, `\` = set difference):

`(STDLIB ∪ include) \ exclude \ (BLOCKLIST \ include)`

An internal blocklist (`assert`, `spy`, `stub`, `mock`, `describe`, `it`, `pending`, `setup`,
`teardown`, `before_each`, `after_each`, `insist`) is always active. Blocklisted roots are
excluded unless the user explicitly names them in `include`.

##### Restoring previous behavior

To hoist all chains regardless of root, set `include: ["*"]`. This enables opt-out mode — all roots
are allowed except those in `exclude` and the internal blocklist (unless also named in `include`).

```jsonc
"localizer": { "include": ["*"] }
```

**Defold engine** — Defold exposes flat function tables (`go`, `msg`, `vmath`, etc.) that are
safe to hoist. List the ones you use:

```jsonc
"localizer": {
  "include": ["go", "msg", "vmath", "sprite", "gui", "sound"]
}
```

**WoW API** — Same pattern for World of Warcraft namespaced APIs:

```jsonc
"localizer": {
  "include": ["C_Timer", "C_Map", "UnitName"]
}
```

**Overriding the internal blocklist** — If you know a blocklisted global is safe in your
codebase (e.g., you use a custom `assert` that is a plain function table), name it explicitly
in `include`:

```jsonc
"localizer": { "include": ["assert"] }
```

### `debug-strip`

Strips debug and profiling calls from the Lua output. **Off by default**; enable it explicitly,
since it removes code rather than optimizing it. Set `"debug-strip": true` for defaults, or pass an
object to customize which calls the rule strips.

```lua
-- Before                          -- After (with debug-strip enabled)
print("player health:", hp)        -- (removed)
debug.traceback()                  -- (removed)
assert(hp > 0)                     -- (removed)
local x = compute()               local x = compute()
```

The rule strips only statement-position calls. It preserves calls whose return value feeds a
variable initializer, return statement, or function argument.

Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `functions` | `string[]` | `["print", "assert"]` | Bare function names to strip |
| `namespaces` | `string[]` | `["debug"]` | Namespace prefixes to strip (`debug.*()`) |

**Limitations:**

- **Name-based matching** — matches Lua-level identifier text, not TS types. A local variable named
  `print` that shadows the global will also be stripped.
- **`assert` removal changes semantics** — strips the runtime error-on-falsy check, not just output.
  Understand this tradeoff before enabling the rule.
- **Custom config replaces defaults** — `functions: ["myDebug"]` replaces the default list; it does
  not extend it. Include defaults explicitly to keep both.

## Strict mode

By default, unresolvable diagnostics from optimization rules are emitted as warnings.
`conditional-compilation` uses code 90002. `inline` emits rule-specific diagnostics: 90001 for a
generic inline failure, plus 90003-90010 for specific rejection reasons. Set `strict: true` at the
plugin level to promote all optimization warnings to compilation errors; the build fails whenever
an optimization cannot be applied:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "strict": true
      }
    ]
  }
}
```

Use a per-rule `strict` override to exempt a specific rule from the global setting. The `inline` and
`conditional-compilation` rules support per-rule strict.

The example below enables global strict but keeps `inline` diagnostics as warnings:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "strict": true,
        "rules": {
          "inline": { "strict": false }
        }
      }
    ]
  }
}
```

This example enables global strict but keeps `conditional-compilation` diagnostics as warnings:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "tstl-optimize",
        "strict": true,
        "rules": {
          "conditional-compilation": {
            "constants": { "DEBUG": { "env": "DEBUG", "default": false } },
            "strict": false
          }
        }
      }
    ]
  }
}
```

Precedence:

- Per-rule `strict: false` always overrides global `strict: true` for that rule.
- Per-rule `strict: true` promotes warnings to errors for that rule even when the global is `false`.

### Diagnostic codes

All diagnostics emitted by the plugin carry `source: "tstl-optimize"` and one of the codes below.

| Code | Rule | Meaning |
| --- | --- | --- |
| 90001 | `inline` | Generic inline failure (fallback when no more specific code applies) |
| 90002 | `conditional-compilation` | Condition mixes compile-time constants with runtime variables; branch cannot be folded |
| 90003 | `inline` | Cross-module inline rejected — body references captured module-scope variables |
| 90004 | `inline` | Direct or mutual recursion detected |
| 90005 | `inline` | Unsupported parameter shape (rest / default / optional / destructuring / parameter write) |
| 90006 | `inline` | Argument has side effects but the parameter is used more than once in an expression body |
| 90007 | `inline` | Body contains an early `return`, unscoped `break`, `continue`, or labeled statement |
| 90008 | `inline` | Target is not module-scope |
| 90009 | `inline` | Multi-statement body used at a void site with disallowed shape |
| 90010 | `inline` | Multi-statement body used at an expression position where `do...end` cannot fit |

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `strict` | `boolean` | `false` | Promote optimization warnings to compilation errors globally. `conditional-compilation` uses code 90002; `inline` emits 90001 and more specific 90003-90010 diagnostics. See [Strict mode](#strict-mode). |
| `rules.conditional-compilation` | `boolean \| ConditionalCompilationConfig` | `false` | Strip dead branches based on compile-time constants. Accepts `{ constants: ...; strict?: boolean }` for per-rule error promotion. |
| `rules.constant-folding` | `boolean` | `true` | Evaluate side-effect-free constant arithmetic, comparison, logical, unary, and string expressions. |
| `rules.math-intrinsics` | `boolean` | `true` | Inline math calls as Lua expressions. |
| `rules.dead-local` | `boolean` | `true` | Remove unused single-name locals inside function bodies when the initializer is pure. |
| `rules.merge-locals` | `boolean` | `true` | Merge consecutive pure single-name local declarations when the merged assignment preserves semantics. |
| `rules.remove-empty-branch` | `boolean` | `true` | Remove empty `if`/`elseif`/`else` branches and promote invertible `else` blocks. |
| `rules.loop-rebase` | `boolean` | `true` | Convert 0-based loops to 1-based. |
| `rules.inline` | `boolean \| { enabled?: boolean; strict?: boolean }` | `true` | Inline `@inline` functions at call sites, including cross-module. Set `enabled: false` to disable; `strict` controls per-rule error promotion (see [Strict mode](#strict-mode)). |
| `rules.localizer` | `boolean \| LocalizerConfig` | `true` | Hoist repeated table-chain lookups into locals; hoists stdlib roots only by default. See the `localizer` section for `include` and `exclude` options. |
| `rules.debug-strip` | `boolean \| DebugStripConfig` | `false` | Strip debug and profiling calls. |
| `target` | `"puc" \| "luajit"` | auto-detected | Lua interpreter target. When omitted, the plugin derives it from TSTL's `luaTarget`. |

### Refold phase

After all rules have run, the plugin re-runs `constant-folding`, `dead-local`, `merge-locals`, and
`remove-empty-branch` in a final "refold" phase. Later rules sometimes create new opportunities for
earlier ones — for example, `localizer` can introduce consecutive `local` declarations that
`merge-locals` can combine, or `inline` can expand a body whose constants `constant-folding` can
evaluate. The refold phase catches these cross-rule wins automatically. Each rule in the refold
phase is still gated by its own `rules.*` toggle, so disabling `merge-locals` globally also
disables it during refold.

## Examples

The [`examples/`](examples/) directory contains a `.ts` / `.lua` pair for each rule, showing the
TypeScript input and generated Lua output. See [`examples/README.md`](examples/README.md) for
details.

## Benchmarks

Microbenchmarks for `math-intrinsics`, `localizer`, `loop-rebase`, and `inline` live in the
[`benchmark/`](benchmark/) directory and run via `npm run bench`. See
[`benchmark/README.md`](benchmark/README.md) for measured speedups on PUC-Rio Lua 5.1 and LuaJIT.

## FAQ

### My `@inline` function isn't being inlined

Check the [`inline` conditions](#inline). Common causes:

- The function captures a module-scope variable (cross-module only — code 90003).
- A parameter is destructured or has a default (code 90005).
- The body has an early `return`, unscoped `break`, or `continue` (code 90007).
- The call is at an expression position but the body has multiple statements (code 90010).

Enable `strict: true` on the `inline` rule to promote the warning to a hard error and see exactly
which condition failed.

### A local variable sharing a stdlib name got rewritten

Rules that match identifiers (`conditional-compilation`, `debug-strip`, `localizer`,
`math-intrinsics`) operate on Lua-level text, not TypeScript types — TSTL has already lowered the
file by the time rules run. A local named `print` is stripped by `debug-strip` just like the
global. Rename the local, or remove the identifier from the rule's match list (`exclude` for
`localizer`, `functions` for `debug-strip`).

### `conditional-compilation` doesn't substitute my constant

The identifier must be declared ambient:

```ts
declare const DEBUG: boolean; // substituted
const DEBUG = false;          // not substituted — real runtime binding
```

The constants map key must match the identifier name exactly; aliasing through another `const` will
not propagate.

### My `localizer` rule doesn't hoist a chain rooted at a library global

The default allowlist is stdlib-only to protect against metatable-based APIs where hoisting would
collapse the `__index` chain and silently change behavior. Add your library roots via `include`:

```jsonc
"localizer": { "include": ["go", "msg", "vmath"] }
```

See [root filtering](#root-filtering) for the full resolution formula and engine-specific examples
(Defold, WoW).

### `npm install` warns about peer dep version

`typescript-to-lua >= 1.22.0` is the documented floor; CI tests against `1.36.0`. Older TSTL
versions may work but are not verified — if you see plugin behavior that contradicts this README,
upgrade TSTL first.

### Can I use this on Lua 5.2 / 5.3 / 5.4?

TSTL accepts those targets, and the plugin will compile without errors, but `math-intrinsics` and
`localizer` are tuned for Lua 5.1 (PUC-Rio) and LuaJIT. Rewrites that are neutral on 5.1 may be
slower on 5.3 (which has a native integer type and a dedicated `//` floor-divide operator). Benchmark
before shipping, and disable specific rules if they regress.

## License

[MIT](LICENSE)
