import { collectRequireBindings, parseLua } from "./parse.js";

/**
 * Extracts require bindings from Lua source.
 *
 * Parses the source and returns a map of TSTL require-binding variable names
 * to their require() paths. Only chunk-level bindings matching the pattern
 * `local ____<word> = require(<string-literal>)` are included.
 *
 * @param luaSource Lua source code string.
 * @returns A read-only map from variable name to require path.
 */
export function getRequireBindings(luaSource: string): ReadonlyMap<string, string> {
  const ast = parseLua(luaSource);
  const raw = collectRequireBindings(ast);
  const result = new Map<string, string>();
  for (const [name, { path }] of raw) {
    result.set(name, path);
  }
  return result;
}
