import luaparse from "luaparse";

/**
 * Parses a Lua source string into an AST Chunk node.
 *
 * Enables `ranges` and `locations` for position information on every node,
 * and disables comment attachment since callers operate on semantic structure.
 *
 * @throws When the source contains syntax errors. The error message includes
 *   the original source for context.
 */
export function parseLua(source: string): luaparse.Chunk {
  try {
    return luaparse.parse(source, { ranges: true, locations: true, comments: false });
  } catch (err) {
    throw new Error(
      `Failed to parse Lua source: ${err instanceof Error ? err.message : String(err)}\n\nSource:\n${source}`,
    );
  }
}

/**
 * Walks chunk-level `LocalStatement` nodes and collects those that match the
 * TSTL require-binding pattern:
 *
 * ```lua
 * local ____mod = require("mod/path")
 * ```
 *
 * All five conditions must hold for a statement to be included:
 * 1. Exactly one variable in the statement
 * 2. Exactly one init expression
 * 3. Variable name matches `/^____\w+$/`
 * 4. Init is a `CallExpression` to an identifier named `require` with exactly one argument
 * 5. That argument is a `StringLiteral`
 *
 * Statements that fail any condition are silently skipped.
 * Only direct children of `ast.body` are examined — nested scopes are ignored.
 *
 * @returns A Map from module variable name to `{ path, node }`.
 */
export function collectRequireBindings(
  ast: luaparse.Chunk,
): Map<string, { path: string; node: luaparse.LocalStatement }> {
  const result = new Map<string, { path: string; node: luaparse.LocalStatement }>();

  for (const stmt of ast.body) {
    if (stmt.type !== "LocalStatement") {
      continue;
    }

    if (stmt.variables.length !== 1 || stmt.init.length !== 1) {
      continue;
    }

    const variable = stmt.variables[0];
    if (!variable || !/^____\w+$/.test(variable.name)) {
      continue;
    }

    const init = stmt.init[0];
    if (
      init?.type !== "CallExpression" ||
      init.base.type !== "Identifier" ||
      init.base.name !== "require" ||
      init.arguments.length !== 1
    ) {
      continue;
    }

    const arg = init.arguments[0];
    if (arg?.type !== "StringLiteral") {
      continue;
    }

    // luaparse sets `.value` to null at runtime despite the type declaration.
    // The `.raw` field contains the quoted string (e.g. `"mod/path"` or `'mod/path'`);
    // stripping the surrounding quote characters gives the unescaped path.
    const path = arg.raw.slice(1, -1);
    result.set(variable.name, { path, node: stmt });
  }

  return result;
}

/**
 * Walks chunk-level `LocalStatement` nodes and collects all declared variable
 * names into a Set.
 *
 * Only direct children of `ast.body` are examined — variables declared inside
 * function bodies or other nested blocks are excluded.
 *
 * @returns A Set of variable names declared at the chunk level.
 */
export function collectExistingLocals(ast: luaparse.Chunk): Set<string> {
  const result = new Set<string>();

  for (const stmt of ast.body) {
    if (stmt.type !== "LocalStatement") {
      continue;
    }

    for (const variable of stmt.variables) {
      result.add(variable.name);
    }
  }

  return result;
}
