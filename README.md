# tstl-optimize

[![CI](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [TypeScriptToLua](https://typescripttolua.github.io/) compiler plugin that generates faster Lua
code through configurable optimization rules. Targets **Lua 5.1 (PUC)** and **LuaJIT**. All rules
default to on except `conditional-compilation` and `debug-strip`, which remove code. Toggle each
rule individually.

```typescript
// TypeScript input                       // Lua output (with plugin)
Math.sqrt(x)                           // x ^ 0.5
math.floor(a) + math.floor(b)          // local ____math_floor = math.floor
                                        // ____math_floor(a) + ____math_floor(b)
/** @inline */
function double(x: number) {            // (inlined at call sites)
  return x * 2;
}
const y = double(5);                    // local y = 5 * 2
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

At build time the rule reads the environment variable named in `env` and falls back to `default`
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

Replaces `Math.*` calls with inline Lua expressions, avoiding the overhead of dispatching through
the `math` table. Skipped on LuaJIT, which already handles C calls fast.

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

Inlines `@inline`-tagged single-expression functions at call sites. Works within the same module and
across module boundaries.

```typescript
/** @inline */
function double(x: number) {
  return x * 2;
}
const y = double(5); // becomes: const y = 5 * 2
```

Cross-module inlining works for self-contained functions — bodies that reference only parameters and
literals. Functions that capture module-scope variables are rejected with a diagnostic warning.

```typescript
// utils.ts
/** @inline */
export function double(x: number) { return x * 2; }       // ✓ cross-module OK
/** @inline */
export function addOffset(x: number) { return x + OFFSET; } // ✗ captures OFFSET

// main.ts
import { double } from "./utils";
const y = double(5); // inlined: const y = 5 * 2
```

A function qualifies for inlining when it meets all these conditions:

- `@inline` JSDoc tag on the function
- Single-expression body (or arrow `=> expr`)
- Module-scope function (not nested)
- No rest, default, or optional parameters
- Non-recursive
- No parameter writes inside the body
- Each parameter used more than once receives only side-effect-free arguments
- Cross-module: body references only parameters and literals (no captured variables)

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

Array element localization handles the simple case only: the base must be a plain identifier, the
index must match exactly the loop control variable, the rule skips loops containing function calls
(a call could modify the array through a reference, making the cached local stale), and skips
write-back candidates in loops with early exits (`break`/`return`).

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

**Resolution formula:** `(STDLIB ∪ include) \ exclude \ (BLOCKLIST \ include)`

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

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `rules.conditional-compilation` | `boolean \| ConditionalCompilationConfig` | `false` | Strip dead branches based on compile-time constants |
| `rules.math-intrinsics` | `boolean` | `true` | Inline math calls as Lua expressions |
| `rules.loop-rebase` | `boolean` | `true` | Convert 0-based loops to 1-based |
| `rules.inline` | `boolean` | `true` | Inline `@inline` functions at call sites, including cross-module |
| `rules.localizer` | `boolean \| LocalizerConfig` | `true` | Hoist repeated table-chain lookups into locals; hoists stdlib roots only by default — see `localizer` section for `include`/`exclude` options |
| `rules.debug-strip` | `boolean \| DebugStripConfig` | `false` | Strip debug/profiling calls |
| `target` | `"puc" \| "luajit"` | auto-detected | Lua interpreter target |

## Examples

The [`examples/`](examples/) directory contains a `.ts` / `.lua` pair for each rule, showing the
TypeScript input and generated Lua output. See [`examples/readme.md`](examples/readme.md) for
details.

## License

[MIT](LICENSE)
