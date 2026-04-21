# Benchmarks

Microbenchmarks for the four rules that produce a measurable runtime impact:
`math-intrinsics`, `localizer`, `loop-rebase`, and `inline`. Each `.ts` file pairs a baseline
version of the workload with the optimized version, compiles both through TSTL with the plugin
active, and runs them under [`luamark`](https://github.com/jeffzi/luamark) for paired timing.

Rules that transform code at build time without runtime impact (`constant-folding`, `dead-local`,
`merge-locals`, `remove-empty-branch`, `conditional-compilation`, `debug-strip`) are not
benchmarked here — their win is smaller/cleaner Lua, measured by inspecting the generated output.

## Running

```bash
npm run bench                   # all interpreters, all files
npm run bench -- lua5.1         # single interpreter
npm run bench -- math-intrinsics.ts   # single file across all interpreters
```

Interpreters are located via `$LUA_51` and `$LUA_JIT` (see `.env.example`) or `$PATH`. Missing
interpreters are skipped with a warning.

## What to expect

Numbers vary across hardware, Lua build, and workload shape. As rough guidance on recent
Apple Silicon:

- **`math-intrinsics`** wins cleanly on PUC Lua 5.1 (no JIT) because inline expressions avoid the
  `math` table dispatch. On LuaJIT the JIT already specializes `math.*` — rewrites are typically
  neutral or slightly slower; run the benchmarks and disable the rule if it regresses on your
  target.
- **`localizer`** helps both interpreters when a chain is read several times in the same scope,
  and helps PUC more than LuaJIT because JIT inlines the lookup anyway.
- **`loop-rebase`** avoids the `i + 1` arithmetic per iteration. Small but consistent win on PUC;
  negligible on LuaJIT.
- **`inline`** eliminates call overhead (stack frame + argument copy). Biggest wins are on small
  hot functions in PUC; LuaJIT already inlines most trace-compiled callees.

Treat any speedup < 5% on a single benchmark as noise. The point of these benchmarks is to catch
regressions in the rewrites, not to ship marketing numbers.

## Adding a benchmark

1. Add `benchmark/<rule>.ts` that imports `compare_time` and `render` from `luamark`.
2. Define baseline and optimized workloads in the same `compare_time` call so they share setup.
3. Run `npm run bench -- <rule>.ts` to validate.
