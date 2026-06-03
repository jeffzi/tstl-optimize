import type ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { type InterpreterTarget, parseConfig, type RulesConfig } from "./config";
import {
  buildOptimizeVisitors,
  mergeVisitor,
  normalizeVisitor,
  type RegisteredVisitor,
} from "./index";

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
  const parsed = parseConfig(config as Record<string, unknown> | undefined);
  if (parsed.target === undefined) {
    parsed.target = options.luaTarget === tstl.LuaTarget.LuaJIT ? "luajit" : "puc";
  }
  return buildOptimizeVisitors(checker, parsed, isOwnedFile);
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
  for (const [k, v] of Object.entries(fallback)) {
    if (v !== undefined) fallbackByKind.set(Number(k), v as RegisteredVisitor);
  }

  for (const [k, rawPrimary] of Object.entries(primary)) {
    const kind = Number(k);
    const primaryEntry = normalizeVisitor(rawPrimary as RegisteredVisitor | undefined);
    const fallbackEntry = fallbackByKind.get(kind);
    fallbackByKind.delete(kind);
    const entry =
      primaryEntry === undefined ? fallbackEntry : mergeVisitor(kind, fallbackEntry, primaryEntry);
    if (entry !== undefined) merged[kind] = entry;
  }

  // Carry forward kinds present only in fallback.
  for (const [kind, entry] of fallbackByKind) {
    merged[kind] = entry;
  }

  return merged as tstl.Visitors;
}
