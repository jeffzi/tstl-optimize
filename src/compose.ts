import type ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import {
  type ConstantValue,
  type InterpreterTarget,
  isRecord,
  parseConfig,
  type RulesConfig,
  resolveConditionalCompilationConfig,
} from "./config";
import {
  buildOptimizeVisitors,
  mergeVisitor,
  normalizeVisitor,
  type RegisteredVisitor,
} from "./index";
import { isTruthy } from "./rules/conditional-compilation/evaluator";

/**
 * Options for {@link createScopedOptimizeVisitors}.
 *
 * Mirrors the `tsconfig.json` plugin config: a partial `rules` map, an explicit
 * interpreter `target`, and `strict`. Unknown keys are ignored, matching the
 * plugin's lenient `parseConfig`. `target` is usually inferred from the
 * consumer's `luaTarget`; set it only to override.
 */
export interface OptimizeComposeOptions {
  rules?: Partial<RulesConfig>;
  target?: InterpreterTarget;
  strict?: boolean;
}

/**
 * Build a file-scoped optimizer visitor map that another TSTL plugin can mount
 * inside the consumer's own transpile (without registering tstl-optimize as a
 * `luaPlugin`).
 *
 * The rules run on the TypeScript AST with the consumer's real `program` /
 * `checker`, so `@inline` resolution and cross-module symbol lookups work
 * against the actual program — no isolated re-transpile. `isOwnedFile` scopes
 * the rules: only files it accepts (keyed on `context.sourceFile.fileName`) are
 * optimized; every other file passes through unchanged.
 *
 * Call this from the mounting plugin's `beforeTransform` (TSTL reads
 * `plugin.visitors` after `beforeTransform`), then assign or merge the result
 * onto the plugin's `visitors` — see {@link mergeVisitorMaps}.
 */
export function createScopedOptimizeVisitors(
  program: ts.Program,
  options: tstl.CompilerOptions,
  isOwnedFile: (fileName: string) => boolean,
  config?: OptimizeComposeOptions,
): tstl.Visitors {
  const checker = program.getTypeChecker();
  // Convert config to plain record; parseConfig accepts unknown and validates internally
  const parsed = parseConfig(isRecord(config) ? config : undefined);
  const targetFromLuaTarget = options.luaTarget === tstl.LuaTarget.LuaJIT ? "luajit" : "puc";
  parsed.target ??= targetFromLuaTarget;
  return buildOptimizeVisitors(checker, parsed, isOwnedFile);
}

/**
 * Find the first `luaPlugins` entry that is the tstl-optimize plugin, by matching
 * its `name` field (if present) against the pattern `/(?:^|[\\/])tstl-optimize(?:[\\/]|$)/`.
 * This matches exact names like "tstl-optimize" and path-based names like
 * "../node_modules/tstl-optimize/dist/index.js", but rejects near-misses like
 * "my-tstl-optimizer".
 *
 * Returns `undefined` when `options.luaPlugins` is absent, empty, or contains no
 * matching entry. Nameless in-memory `{ plugin }` entries are skipped.
 */
export function findOptimizerPluginEntry(
  options: tstl.CompilerOptions,
): Record<string, unknown> | undefined {
  const plugins = options.luaPlugins;
  if (!Array.isArray(plugins)) {
    return undefined;
  }

  const pattern = /(?:^|[\\/])tstl-optimize(?:[\\/]|$)/;

  for (const entry of plugins) {
    if (!isRecord(entry)) {
      continue;
    }

    const name = entry.name;
    if (typeof name === "string" && pattern.test(name)) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Merge two visitor maps into one, so a mounting plugin can chain its own
 * visitors with the optimizer's without hand-rolling per-`SyntaxKind` fallback.
 *
 * For a kind both maps handle, `primary` runs first and `fallback` runs only
 * when `primary` returns `undefined` (the same "newer-first, older-as-fallback"
 * chaining the plugin uses internally, with the correct per-kind super-fallback
 * so nothing is erased). For a kind only one map handles, that entry is used
 * unchanged. Order the arguments by desired precedence — pass your own visitors
 * first to let them win, with the optimizer's as the fallback.
 */
export function mergeVisitorMaps(primary: tstl.Visitors, fallback: tstl.Visitors): tstl.Visitors {
  const merged: Record<number, RegisteredVisitor> = {};

  // Index fallback by numeric kind for O(1) lookup during the primary sweep.
  // Guard against explicit `undefined` values: Object.entries includes keys set to
  // `undefined` (e.g. a caller's `{ [kind]: flag ? fn : undefined }`), so filter
  // them out rather than propagating them into the merged map.
  const fallbackByKind = new Map<number, RegisteredVisitor>();
  for (const [kindStr, visitor] of Object.entries(fallback)) {
    if (visitor !== undefined) {
      // visitor is not undefined due to the guard above, so it's safely a RegisteredVisitor
      fallbackByKind.set(Number(kindStr), visitor as RegisteredVisitor);
    }
  }

  for (const [kindStr, rawPrimary] of Object.entries(primary)) {
    const kind = Number(kindStr);
    // rawPrimary from Object.entries of tstl.Visitors; filter out undefined values.
    // TSTL visitor types are complex unions; after checking shape, we safely cast.
    const isValidVisitor =
      typeof rawPrimary === "function" || (rawPrimary && typeof rawPrimary === "object");
    const primaryVisitor = isValidVisitor ? (rawPrimary as RegisteredVisitor) : undefined;
    const normalizedPrimary = normalizeVisitor(primaryVisitor);
    const fallbackEntry = fallbackByKind.get(kind);
    fallbackByKind.delete(kind);
    const mergedEntry =
      normalizedPrimary === undefined
        ? fallbackEntry
        : mergeVisitor(kind, fallbackEntry, normalizedPrimary);
    if (mergedEntry !== undefined) merged[kind] = mergedEntry;
  }

  // Carry forward kinds present only in fallback.
  for (const [kind, entry] of fallbackByKind) {
    merged[kind] = entry;
  }

  return merged as tstl.Visitors;
}

/**
 * Resolve a single constant from compiler options exactly as the
 * `conditional-compilation` rule does at transpile time.
 *
 * Searches for the tstl-optimize plugin in `options.luaPlugins`, parses its
 * rule config, resolves the conditional-compilation constants (with env
 * overrides and coercion), and returns the value for the given constant name.
 *
 * Returns `undefined` if any step fails: no plugin found, rule disabled or
 * absent, or constant name not in the resolved map.
 *
 * This is a pure composition function — it has no side effects and replicates
 * the transpile-time resolution logic for use in build tools, test setup, and
 * configuration validation.
 */
export function resolveConstantFromOptions(
  options: tstl.CompilerOptions,
  name: string,
): ConstantValue | undefined {
  const entry = findOptimizerPluginEntry(options);
  if (!entry) return undefined;

  const parsed = parseConfig(entry);
  const resolved = resolveConditionalCompilationConfig(parsed.rules["conditional-compilation"]);
  if (resolved === false) return undefined;

  return resolved.get(name);
}

/**
 * Re-export of `ConstantValue` type from config.
 *
 * The union of all constant types: `boolean | number | string`.
 */
export type { ConstantValue };
/**
 * Re-export of `isTruthy` from the conditional-compilation evaluator.
 *
 * Returns `true` for all values except `false`, `0`, and `""`.
 *
 * @example
 * isTruthy(true);   // → true
 * isTruthy(1);      // → true
 * isTruthy("x");    // → true
 * isTruthy(false);  // → false
 * isTruthy(0);      // → false
 * isTruthy("");     // → false
 */
export { isTruthy };
