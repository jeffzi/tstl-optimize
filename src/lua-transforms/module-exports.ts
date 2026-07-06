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
      if (
        stmt.identifier &&
        stmt.identifier.type === "MemberExpression" &&
        stmt.identifier.base.type === "Identifier" &&
        stmt.identifier.base.name === "____exports"
      ) {
        result.add(stmt.identifier.identifier.name);
      }
    } else if (stmt.type === "AssignmentStatement") {
      for (const variable of stmt.variables) {
        if (variable.type === "MemberExpression") {
          if (
            variable.indexer === "." &&
            variable.base.type === "Identifier" &&
            variable.base.name === "____exports"
          ) {
            result.add(variable.identifier.name);
          }
        } else if (variable.type === "IndexExpression") {
          if (
            variable.base.type === "Identifier" &&
            variable.base.name === "____exports" &&
            variable.index.type === "StringLiteral"
          ) {
            result.add(variable.index.raw.slice(1, -1));
          }
        }
      }
    }
  }

  return result;
}
