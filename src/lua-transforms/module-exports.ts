import type luaparse from "luaparse";

import { parseLua } from "./parse.js";

/**
 * Extracts module export names from Lua source.
 *
 * Parses the source and returns a set of export names contributed by
 * chunk-level statements that assign to `____exports.<name>` or declare
 * `function ____exports.name()`.
 *
 * Patterns recognized:
 * - `function ____exports.name(...) end`
 * - `____exports.name = <value>`
 * - `____exports["name"] = <value>`
 *
 * Patterns ignored:
 * - Nested writes like `____exports.name.sub = <value>` (only `name.sub` is
 *   the target, not a direct `____exports` member)
 * - Statements not at chunk level
 *
 * @param luaSource Lua source code string.
 * @returns A read-only set of exported member names.
 */
export function getModuleExports(luaSource: string): ReadonlySet<string> {
  const ast = parseLua(luaSource);
  const result = new Set<string>();

  for (const stmt of ast.body) {
    if (stmt.type === "FunctionDeclaration") {
      const fn = stmt as luaparse.FunctionDeclaration;
      if (
        fn.identifier &&
        fn.identifier.type === "MemberExpression" &&
        fn.identifier.base.type === "Identifier" &&
        (fn.identifier.base as luaparse.Identifier).name === "____exports"
      ) {
        result.add((fn.identifier as luaparse.MemberExpression).identifier.name);
      }
    } else if (stmt.type === "AssignmentStatement") {
      const assign = stmt as luaparse.AssignmentStatement;
      for (const variable of assign.variables) {
        if (variable.type === "MemberExpression") {
          const mem = variable as luaparse.MemberExpression;
          if (
            mem.indexer === "." &&
            mem.base.type === "Identifier" &&
            (mem.base as luaparse.Identifier).name === "____exports"
          ) {
            result.add(mem.identifier.name);
          }
        } else if (variable.type === "IndexExpression") {
          const idx = variable as luaparse.IndexExpression;
          if (
            idx.base.type === "Identifier" &&
            (idx.base as luaparse.Identifier).name === "____exports" &&
            idx.index.type === "StringLiteral"
          ) {
            const raw = (idx.index as luaparse.StringLiteral).raw;
            result.add(raw.slice(1, -1));
          }
        }
      }
    }
  }

  return result;
}
