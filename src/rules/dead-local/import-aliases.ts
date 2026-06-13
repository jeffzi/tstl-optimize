// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { forEachAccess } from "../../ast/lua-references";
import { collectReadSymbols } from "./access";

// TSTL names its synthetic require-binding locals with a `____` prefix (e.g. `____mod`).
const TSTL_REQUIRE_BINDING_PATTERN = /^____\w+$/;

interface RequireBinding {
  stmt: tstl.VariableDeclarationStatement;
  modulePath: string;
  id: tstl.Identifier;
}

interface ImportAlias {
  stmt: tstl.VariableDeclarationStatement;
  requireId: tstl.Identifier;
  aliasId: tstl.Identifier;
}

function matchRequireBinding(stmt: tstl.Statement): RequireBinding | undefined {
  if (!tstl.isVariableDeclarationStatement(stmt) || stmt.left.length !== 1 || !stmt.right?.length) {
    return undefined;
  }

  const id = stmt.left[0];
  if (!TSTL_REQUIRE_BINDING_PATTERN.test(id.text)) {
    return undefined;
  }

  const rhs = stmt.right[0];
  if (!tstl.isCallExpression(rhs)) {
    return undefined;
  }

  const { expression, params } = rhs;
  if (!tstl.isIdentifier(expression) || expression.text !== "require" || params.length !== 1) {
    return undefined;
  }

  const arg = params[0];
  /* v8 ignore next -- TSTL always emits require() with a string literal argument */
  if (!tstl.isStringLiteral(arg)) return undefined;

  return { stmt, modulePath: arg.value, id };
}

function matchImportAlias(
  stmt: tstl.Statement,
  requireIdsByText: Map<string, RequireBinding>,
): ImportAlias | undefined {
  if (!tstl.isVariableDeclarationStatement(stmt) || stmt.left.length !== 1 || !stmt.right?.length) {
    return undefined;
  }

  const aliasId = stmt.left[0];
  const rhs = stmt.right[0];
  if (!tstl.isTableIndexExpression(rhs)) {
    return undefined;
  }

  const table = rhs.table;
  /* v8 ignore next -- TSTL import aliases always index an Identifier bound to a require */
  if (!tstl.isIdentifier(table)) return undefined;

  const binding = requireIdsByText.get(table.text);
  if (!binding) return undefined;

  return {
    stmt,
    requireId: binding.id,
    aliasId,
  };
}

function removeStatements(statements: tstl.Statement[], toRemove: Set<tstl.Statement>): void {
  if (toRemove.size === 0) return;
  const kept = statements.filter((s) => !toRemove.has(s));
  statements.splice(0, statements.length, ...kept);
}

/**
 * Collects names of identifiers that appear in read positions with symbolId === undefined.
 * These are typically plugin-emitted identifiers (e.g., JSX-transpiled code) that lack
 * TSTL's normal symbolId tracking.
 */
function collectUndefinedSymbolIdReads(statements: readonly tstl.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of statements) {
    forEachAccess(stmt, ({ identifier, kind }) => {
      if (kind === "read" && identifier.symbolId === undefined) {
        names.add(identifier.text);
      }
    });
  }
  return names;
}

/**
 * Eliminates dead import aliases (locals aliasing require() module members) at module scope.
 *
 * **Algorithm:**
 * 1. Scan for require bindings: `local ____mod = require("path")`
 * 2. Scan for import aliases: `local name = ____mod.member`
 * 3. Collect all identifier reads in the module (keying by identifier object ref)
 * 4. Mark aliases whose identifier is not in the read set for removal
 * 5. Filter statements, removing dead aliases
 * 6. Re-scan reads on the filtered list
 * 7. Mark require bindings with no live aliases and no other reads for removal
 * 8. Filter statements, removing dead requires
 *
 * **Safety note:** We only match the structural pattern (require binding + table index expression)
 * and require that the table matches a known require binding. This is safe because:
 * - TSTL generates all require bindings and import aliases deterministically
 * - No user code directly creates `____mod = require(...)` patterns
 * - We use Identifier object references as keys, not symbolIds (which TSTL doesn't assign)
 */
export function eliminateDeadImportAliases(statements: tstl.Statement[]): void {
  const requireBindings = new Map<string, RequireBinding>();
  const importAliases: ImportAlias[] = [];

  for (const stmt of statements) {
    const binding = matchRequireBinding(stmt);
    if (binding) {
      requireBindings.set(binding.id.text, binding);
    }
  }

  if (requireBindings.size === 0) {
    return;
  }

  for (const stmt of statements) {
    const alias = matchImportAlias(stmt, requireBindings);
    if (alias) {
      importAliases.push(alias);
    }
  }

  if (importAliases.length === 0) {
    return;
  }

  const reads = new Set<number>();
  collectReadSymbols(statements, reads);

  // Collect identifiers read with symbolId === undefined. These are typically plugin-emitted
  // identifiers (e.g., JSX code) that lack TSTL's symbolId tracking. We must conservatively
  // keep aliases whose names match, even if their own symbolId is not in the read set.
  const undefinedSymbolIdReads = collectUndefinedSymbolIdReads(statements);

  const aliasesToRemove = new Set<tstl.Statement>();
  const aliveRequireIds = new Set<tstl.Identifier>();

  for (const alias of importAliases) {
    if (alias.aliasId.symbolId === undefined) {
      // Plugin-emitted identifiers lack symbolId — we cannot reliably track reads via symbolId.
      // Treat conservatively: assume they might be read and keep the alias and its require.
      aliveRequireIds.add(alias.requireId);
    } else if (
      reads.has(alias.aliasId.symbolId) ||
      undefinedSymbolIdReads.has(alias.aliasId.text)
    ) {
      // Alias is either read via its symbolId, or read via an undefined-symbolId identifier
      // with the same name (e.g., JSX-transpiled code). Keep the alias and its require.
      aliveRequireIds.add(alias.requireId);
    } else {
      aliasesToRemove.add(alias.stmt);
    }
  }

  removeStatements(statements, aliasesToRemove);

  const updatedReads = new Set<number>();
  collectReadSymbols(statements, updatedReads);

  const requiresToRemove = new Set<tstl.Statement>();
  for (const binding of requireBindings.values()) {
    const hasLiveAlias = aliveRequireIds.has(binding.id);
    const hasOtherRead = binding.id.symbolId !== undefined && updatedReads.has(binding.id.symbolId);

    if (!hasLiveAlias && !hasOtherRead) {
      requiresToRemove.add(binding.stmt);
    }
  }

  removeStatements(statements, requiresToRemove);
}
