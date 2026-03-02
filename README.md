# tstl-optimize

[![CI](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffzi/tstl-optimize/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [TypeScriptToLua](https://typescripttolua.github.io/) compiler plugin that generates faster Lua
code through configurable optimization rules. Targets **Lua 5.1 (PUC)** and **LuaJIT**. Every
rule is on by default; toggle each one individually.

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
          "localizer": { "threshold": 3, "scope": "function" }
        },
        // Optional: auto-detected from luaTarget when omitted
        "target": "puc" // or "luajit"
      }
    ]
  }
}
```

## Rules

### `math-intrinsics`

Replaces `Math.*` calls with inline Lua expressions, eliminating the overhead of a C function call
through the `math` table. Skipped for `"luajit"` because LuaJIT already dispatches C calls fast.

| Source | Lua output | Notes |
| --- | --- | --- |
| `Math.sqrt(x)` | `x ^ 0.5` | Lossless |
| `Math.floor(x)` | `x - x % 1` | Lossless |
| `Math.abs(x)` | `(x < 0) and -x or x` | Lossy for `-0` (returns `-0` instead of `0`) |
| `Math.max(a, b)` | `(a > b) and a or b` | 2-arg only. Returns `b` when either arg is `NaN` |
| `Math.min(a, b)` | `(a < b) and a or b` | 2-arg only. Returns `b` when either arg is `NaN` |
| `x ** 2` | `x * x` | Lossless. Literal `2` exponent only |

The rule applies `abs`, `max`, and `min` only to side-effect-free arguments, so duplicating them in
the output stays safe.

> **Edge cases:** The `-0` and `NaN` deviations are deliberate trade-offs. Typical Lua 5.1 game
> code never observes these values. If your code relies on IEEE 754 `NaN` propagation or `-0`
> semantics, disable this rule.

### `loop-rebase`

Converts 0-based `$range` for-of loops into 1-based Lua for loops when the body references the loop
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

The rule bails out when the body assigns the control variable, references it without `+ 1`, or
shadows it in a nested declaration.

### `inline`

Inlines `@inline`-tagged single-expression functions at call sites.

```typescript
/** @inline */
function double(x: number) {
  return x * 2;
}
const y = double(5); // becomes: const y = 5 * 2
```

A function qualifies for inlining when it meets all these conditions:

- `@inline` JSDoc tag on the function
- Single-expression body (or arrow `=> expr`)
- Module-scope function (not nested)
- No rest, default, or optional parameters
- Not recursive
- No parameter writes inside the body
- Each parameter used more than once receives only side-effect-free arguments

### `localizer`

Hoists repeated table-index chains (e.g., `math.floor`, `game.players.count`) into local variables
at the top of the scope. Inside loop bodies, repeated `arr[i]` accesses (where `i` is the loop
control variable) are also localized; a write-back is appended when the element is assigned.

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

Array element localization handles only the simple case: the base must be a plain identifier, the
index must be exactly a loop control variable, loops with function calls are skipped entirely (a call could
modify the array through a reference, making the cached local stale), and loops with early exits
(`break`/`return`) skip write-back candidates.

Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | `2` | Minimum read-count before hoisting |
| `scope` | `"module" \| "function" \| "all"` | `"all"` | Where hoisting is applied |

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `rules.math-intrinsics` | `boolean` | `true` | Enable math intrinsic inlining |
| `rules.loop-rebase` | `boolean` | `true` | Enable 0-to-1-based loop conversion |
| `rules.inline` | `boolean` | `true` | Enable `@inline` function inlining |
| `rules.localizer` | `boolean \| LocalizerConfig` | `true` | Enable table-chain hoisting |
| `target` | `"puc" \| "luajit"` | auto-detected | Lua interpreter target |

## Examples

The [`examples/`](examples/) directory contains a `.ts` / `.lua` pair for each rule, showing the
TypeScript input and generated Lua output. See [`examples/readme.md`](examples/readme.md) for
details.

## License

[MIT](LICENSE)
