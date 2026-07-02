# Examples

Each `.ts` file demonstrates one optimization rule. The accompanying `.lua` file
shows the generated output with all rules enabled (PUC Lua 5.1 target). Open each `.ts` beside
its `.lua` to see the transform in context — the examples are ordered top-down so the rewritten
lines line up visually.

Regenerate the Lua files:

```bash
npm run examples
```

> **Note:** `examples/tsconfig.json` is type-check only (`noEmit: true`) and does **not** invoke the
> plugin. Compilation runs through `scripts/examples.ts`, which uses `tstl.transpileVirtualProject`.
> For a runnable project setup, see the Usage section in the top-level [`README`](../README.md).

| File                                                  | Rule                      | Description                                                                        |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| [conditional-compilation](conditional-compilation.ts) | `conditional-compilation` | Strips dead `if`/ternary/`switch` branches based on compile-time constants         |
| [constant-folding](constant-folding.ts)               | `constant-folding`        | Evaluates constant arithmetic, comparison, logical, and string expressions         |
| [constant-propagation](constant-propagation.ts)       | `constant-propagation`    | Substitutes literal values for single-assignment locals                            |
| [dead-local](dead-local.ts)                           | `dead-local`              | Removes unused local variable declarations inside function bodies                  |
| [debug-strip](debug-strip.ts)                         | `debug-strip`             | Strips statement-position debug calls (`print`, `assert`, `debug.*`)               |
| [inline](inline.ts)                                   | `inline`                  | Inlines `@inline`-tagged functions at call sites, including multi-statement bodies |
| [localizer](localizer.ts)                             | `localizer`               | Hoists repeated table-index chains into local variables                            |
| [loop-rebase](loop-rebase.ts)                         | `loop-rebase`             | Converts 0-based `$range` loops into 1-based Lua loops                             |
| [math-intrinsics](math-intrinsics.ts)                 | `math-intrinsics`         | Replaces `Math.*` calls with inline Lua expressions                                |
| [merge-locals](merge-locals.ts)                       | `merge-locals`            | Merges consecutive `local` declarations into a single statement                    |
| [remove-empty-branch](remove-empty-branch.ts)         | `remove-empty-branch`     | Removes empty `if`/`do` branches and promotes `else` when `if`-block is empty      |
| [unspill](unspill.ts)                                 | `unspill`                 | Folds redundant base/key temps from compound assignment on element/index access    |

Each example includes a **Limitations** section showing cases where the rule skips the optimization, with comments
explaining why.
