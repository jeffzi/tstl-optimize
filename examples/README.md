# Examples

Each `.ts` file demonstrates one optimization rule. The accompanying `.lua` file
shows the generated output with all rules enabled (PUC Lua 5.1 target).

Regenerate the Lua files:

```bash
npm run examples
```

| File                                  | Rule              | Description                                                        |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| [inline](inline.ts)                   | `inline`          | Inlines `@inline`-tagged single-expression functions at call sites |
| [localizer](localizer.ts)             | `localizer`       | Hoists repeated table-index chains into local variables            |
| [loop-rebase](loop-rebase.ts)         | `loop-rebase`     | Converts 0-based `$range` loops into 1-based Lua loops             |
| [math-intrinsics](math-intrinsics.ts) | `math-intrinsics` | Replaces `Math.*` calls with inline Lua expressions                |

Each example includes a **Limitations** section showing cases where the rule skips the optimization, with comments
explaining why.
