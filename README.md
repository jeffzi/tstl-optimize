# tstl-optimize

[![CI](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [TypeScriptToLua](https://typescripttolua.github.io/) compiler plugin that optimizes Lua output with configurable rules. It supports **Lua 5.1 (PUC)** and **LuaJIT**. You can toggle each rule individually. Most rules are on by default, except for `conditional-compilation` and `debug-strip`, which remove code.

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

## Installation

```bash
npm install tstl-optimize
```

**Peer dependency:** `typescript-to-lua >= 1.22.0`

## Usage

Add the plugin to your `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "plugins": [{ "name": "tstl-optimize" }]
  }
}
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
- Measure `math-intrinsics` on your target interpreter. Some rewrites help on PUC Lua, some are
  neutral, and LuaJIT may prefer the built-in C calls.
- Keep separate dev and release configs when you enable code-removal rules.

## Rules

### `conditional-compilation`

Evaluates compile-time constants and strips dead branches from `if`/ternary/`switch` statements.
**Off by default** — enable it with a constants map binding each identifier to an environment
variable and a default value.

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

### `math-intrinsics`

Replaces `Math.*` calls with inline Lua expressions and avoids the dispatch overhead of going
through the `math` table. The rule skips LuaJIT targets, which already handle C calls efficiently.

| Source | Lua output | Notes |
| --- | --- | --- |
| `Math.sqrt(x)` | `x ^ 0.5` | Lossless |
| `Math.floor(x)` | `x - x % 1` | Lossless |
| `Math.abs(x)` | `(x < 0) and -x or x` | Lossy for `-0` (returns `-0` instead of `0`) |
| `Math.max(a, b)` | `(a > b) and a or b` | 2-arg only. Returns `b` when either arg is `NaN` |
| `Math.min(a, b)` | `(a < b) and a or b` | 2-arg only. Returns `b` when either arg is `NaN` |
| `x ** 2` | `x * x` | Lossless. Literal `2` exponent only |

The rule inlines `abs`, `max`, and `min` only for side-effect-free arguments, so duplicating them in
the output stays safe.

> **Edge cases:** The `-0` and `NaN` deviations are deliberate trade-offs. Typical Lua 5.1 game
> code never observes these values. If your code relies on IEEE 754 `NaN` propagation or `-0`
> semantics, disable this rule.

### `loop-rebase`

Converts 0-based `$range` for-of loops into 1-based Lua for loops when the body uses the loop
variable only as `i + 1`.

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

The rule bails out when the body assigns the control variable, uses it without `+ 1`, or shadows it
in a nested declaration.

### `inline`

Inlines `@inline`-tagged functions at call sites, both within the same module and across module boundaries.

```typescript
/** @inline */
function double(x: number) {
  return x * 2;
}
const y = double(5); // becomes: const y = 5 * 2
```

Cross-module inlining works for self-contained functions that only reference parameters and literals. The rule skips functions that capture module-scope variables and issues a diagnostic warning (code 90001).

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

The plugin supports multi-statement function bodies at statement-level call sites. It expands these in-place, wrapping them in a `do...end` block (except at return sites) to prevent variable name leakage.

##### Pattern 1 — Void statement site

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

##### Pattern 2 — Variable-declaration site

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

##### Pattern 3 — Return site

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

##### Pattern 4 — Destructuring site

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

##### Pattern 5 — LuaMultiReturn destructuring site

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

A multi-statement `@inline` function with an empty body is erased silently at statement sites — no
`do...end` is emitted.

#### Call-site limitations

Multi-statement inline is rejected with a diagnostic warning (code 90001) at expression positions
where the result feeds another expression. The function declaration is kept and the call is left
unchanged:

```typescript
// Not inlined — expression position
const r = effect(a) + 1;   // warns: multi-statement body cannot be inlined at expression position
bar(effect(a));             // warns: same reason
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

Subsequent rules in the pipeline process inlined `do...end` blocks. For example, if an inlined body calls `Math.floor(x)` multiple times, the `localizer` rule hoists a `____math_floor` local as it would for hand-written code. `math-intrinsics` rewrites `Math.*` calls inside inlined bodies the same way. Rules apply to the fully expanded output, so inlined code receives the same optimizations as the rest of the file.

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

Strips debug and profiling calls from the Lua output. **Off by default** — enable it explicitly,
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

By default, unresolvable diagnostics from optimization rules are emitted as warnings. The `inline`
rule uses code 90001; `conditional-compilation` uses code 90002. Set `strict: true` at the plugin
level to promote all optimization warnings to compilation errors; the build fails whenever an
optimization cannot be applied:

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
`conditional-compilation` rules support per-rule strict. The example below enables global strict but
keeps inline diagnostics as warnings:

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

Precedence:

- Per-rule `strict: false` always overrides global `strict: true` for that rule.
- Per-rule `strict: true` promotes warnings to errors for that rule even when the global is `false`.

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `strict` | `boolean` | `false` | Promote all optimization warnings (inline code 90001, conditional-compilation code 90002) to compilation errors globally. See [Strict mode](#strict-mode). |
| `rules.conditional-compilation` | `boolean \| ConditionalCompilationConfig` | `false` | Strip dead branches based on compile-time constants. Accepts `{ constants: ...; strict?: boolean }` for per-rule error promotion. |
| `rules.math-intrinsics` | `boolean` | `true` | Inline math calls as Lua expressions |
| `rules.loop-rebase` | `boolean` | `true` | Convert 0-based loops to 1-based |
| `rules.inline` | `boolean \| { enabled?: boolean; strict?: boolean }` | `true` | Inline `@inline` functions at call sites, including cross-module. Set `enabled: false` to disable; `strict` controls per-rule error promotion (see [Strict mode](#strict-mode)). |
| `rules.localizer` | `boolean \| LocalizerConfig` | `true` | Hoist repeated table-chain lookups into locals; hoists stdlib roots only by default — see `localizer` section for `include`/`exclude` options |
| `rules.debug-strip` | `boolean \| DebugStripConfig` | `false` | Strip debug/profiling calls |
| `target` | `"puc" \| "luajit"` | auto-detected | Lua interpreter target |

## Examples

The [`examples/`](examples/) directory contains a `.ts` / `.lua` pair for each rule, showing the
TypeScript input and generated Lua output. See [`examples/README.md`](examples/README.md) for
details.

## License

[MIT](LICENSE)
