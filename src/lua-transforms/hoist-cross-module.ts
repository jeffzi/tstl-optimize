import type luaparse from "luaparse";
import { collectExistingLocals, collectRequireBindings, parseLua } from "./parse.js";

export interface HoistResult {
  /** Transformed Lua source. */
  source: string;
  /**
   * Bare-name → origin map for every hoisted symbol visible in `source`.
   * Includes both freshly hoisted symbols (this pass) and pre-existing hoists
   * detected via the idempotency rule. Describes the post-transform state,
   * not just this pass's edits. Empty if no hoists are present.
   */
  localizedSymbols: ReadonlyMap<string, { moduleVar: string; memberName: string }>;
}

interface Edit {
  offset: number;
  length: number;
  replacement: string;
}

interface RequireInfo {
  statement: luaparse.LocalStatement;
  index: number;
  moduleVar: string;
  path: string;
}

interface PreExistingHoist {
  name: string;
  moduleVar: string;
  node: luaparse.LocalStatement;
}

function walkAstNode(node: luaparse.Node, onNode: (n: luaparse.Node) => void): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return;
  }

  onNode(node);

  for (const key in node as unknown as Record<string, unknown>) {
    if (Object.hasOwn(node, key)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          walkAstNode(item as luaparse.Node, onNode);
        }
      } else if (value !== null && typeof value === "object") {
        walkAstNode(value as luaparse.Node, onNode);
      }
    }
  }
}

/**
 * Hoists cross-module member accesses into local variables for efficiency.
 *
 * For each require-bound module, walks the source AST to find member accesses
 * (e.g., `____mod.foo`) and inserts `local foo = ____mod.foo` declarations
 * after the require statement. Rewrites all member access references to use
 * the hoisted local instead.
 *
 * Implements idempotency: if a member is already hoisted immediately after the
 * require (e.g., `local foo = ____mod.foo`), the function recognizes it and
 * does not insert a duplicate.
 *
 * Detects collisions:
 * - Two modules contributing the same member name → throws
 * - Hoisted name shadowing an existing chunk-level local → throws
 *
 * Declaration LHSes (function identifier in FunctionDeclaration, variables in
 * AssignmentStatement) are skipped and not rewritten.
 *
 * @param luaSource - Lua source code
 * @returns HoistResult with transformed source and localizedSymbols map
 * @throws If collision detected (duplicate hoisted names or shadowing)
 */
export function hoistCrossModuleAccesses(luaSource: string): HoistResult {
  const ast = parseLua(luaSource);

  // Collect require bindings at chunk level
  const requireBindings = collectRequireBindings(ast);
  if (requireBindings.size === 0) {
    return {
      source: luaSource,
      localizedSymbols: new Map(),
    };
  }

  // Build require info with body indices for insertion point logic
  const requireInfos = new Map<string, RequireInfo>();
  for (const [moduleVar, binding] of requireBindings) {
    const index = ast.body.findIndex((stmt) => stmt === binding.node);
    if (index >= 0) {
      requireInfos.set(moduleVar, {
        statement: binding.node,
        index,
        moduleVar,
        path: binding.path,
      });
    }
  }

  // Collect pre-existing hoists (consecutive LocalStatements after each require)
  const preExistingHoists = new Map<string, PreExistingHoist[]>();
  for (const [moduleVar, info] of requireInfos) {
    const hoists: PreExistingHoist[] = [];
    let currentIndex = info.index + 1;

    while (currentIndex < ast.body.length) {
      const stmt = ast.body[currentIndex];
      if (stmt.type !== "LocalStatement") {
        break;
      }

      const local = stmt as luaparse.LocalStatement;
      if (local.variables.length !== 1 || local.init.length !== 1) {
        break;
      }

      const varName = local.variables[0].name;
      const init = local.init[0];
      if (
        init.type === "MemberExpression" &&
        init.base.type === "Identifier" &&
        (init.base as luaparse.Identifier).name === moduleVar &&
        (init.identifier as luaparse.Identifier).name === varName
      ) {
        hoists.push({
          name: varName,
          moduleVar,
          node: local,
        });
        currentIndex++;
      } else {
        break;
      }
    }

    if (hoists.length > 0) {
      preExistingHoists.set(moduleVar, hoists);
    }
  }

  // Build map of all existing locals at chunk level for collision detection
  const existingLocals = collectExistingLocals(ast);

  // Scan AST for member accesses to hoist, collecting them in source order
  const accessesToHoist = new Map<string, { moduleVar: string; order: number }>();
  const accessesByModule = new Map<string, Set<string>>();

  // First pass: collect all member accesses with their source positions
  const memberAccesses: Array<{
    name: string;
    moduleVar: string;
    offset: number;
  }> = [];
  const declarationLhses = new Set<luaparse.Node>();

  walkAstNode(ast, (node) => {
    if (node.type === "FunctionDeclaration") {
      const func = node as luaparse.FunctionDeclaration;
      if (func.identifier && func.identifier.type === "MemberExpression") {
        declarationLhses.add(func.identifier);
      }
    } else if (node.type === "AssignmentStatement") {
      const assign = node as luaparse.AssignmentStatement;
      for (const variable of assign.variables) {
        if (variable.type === "MemberExpression") {
          declarationLhses.add(variable);
        }
      }
    }
  });

  walkAstNode(ast, (node) => {
    if (node.type === "MemberExpression" && !declarationLhses.has(node as luaparse.Node)) {
      const member = node as luaparse.MemberExpression;
      if (member.base.type === "Identifier") {
        const moduleVar = (member.base as luaparse.Identifier).name;
        if (requireInfos.has(moduleVar)) {
          const memberName = (member.identifier as luaparse.Identifier).name;
          const preExisting = preExistingHoists.get(moduleVar);
          if (!preExisting || !preExisting.some((h) => h.name === memberName)) {
            const offset = (member as unknown as { range: [number, number] }).range[0];
            memberAccesses.push({ name: memberName, moduleVar, offset });
          }
        }
      }
    }
  });

  // Sort by source offset to get first-access order
  memberAccesses.sort((a, b) => a.offset - b.offset);

  // Now populate accessesToHoist in source order
  for (let i = 0; i < memberAccesses.length; i++) {
    const { name, moduleVar } = memberAccesses[i];
    if (!accessesToHoist.has(name)) {
      accessesToHoist.set(name, { moduleVar, order: i });
    }
    if (!accessesByModule.has(name)) {
      accessesByModule.set(name, new Set());
    }
    accessesByModule.get(name)!.add(moduleVar);
  }

  // Detect collisions: two modules same name or shadowing existing local
  for (const [name] of accessesToHoist) {
    if (accessesByModule.get(name)?.size && accessesByModule.get(name)!.size > 1) {
      const mods = Array.from(accessesByModule.get(name)!);
      throw new Error(
        `Collision: member name "${name}" contributed by multiple modules: ${mods.join(", ")}`,
      );
    }

    if (existingLocals.has(name)) {
      throw new Error(`Collision: hoisted name "${name}" shadows existing chunk-level local`);
    }
  }

  // Build edits for insertions (new hoists) and replacements (access rewrites)
  const edits: Edit[] = [];
  const localizedSymbols = new Map<string, { moduleVar: string; memberName: string }>();

  // Populate localizedSymbols from pre-existing hoists
  for (const [moduleVar, hoists] of preExistingHoists) {
    for (const hoist of hoists) {
      localizedSymbols.set(hoist.name, { moduleVar, memberName: hoist.name });
    }
  }

  // Process each require binding
  for (const [moduleVar, info] of requireInfos) {
    // Collect new hoists (accesses not already hoisted), sorted by first access order
    const toInsertUnsorted: Array<{ name: string; order: number }> = [];

    for (const [name, { moduleVar: originModule, order }] of accessesToHoist) {
      if (originModule === moduleVar) {
        const preExisting = preExistingHoists.get(moduleVar);
        if (!preExisting || !preExisting.some((h) => h.name === name)) {
          toInsertUnsorted.push({ name, order });
          localizedSymbols.set(name, { moduleVar, memberName: name });
        }
      }
    }

    // Sort by access order to maintain first-reference order
    const toInsert = toInsertUnsorted.sort((a, b) => a.order - b.order).map((x) => x.name);

    if (toInsert.length > 0) {
      // Compute insertion point: after the last pre-existing hoist or after the require
      let insertAfterNode = info.statement;
      const preExisting = preExistingHoists.get(moduleVar);
      if (preExisting && preExisting.length > 0) {
        insertAfterNode = preExisting[preExisting.length - 1].node;
      }

      const insertAfterRange = (insertAfterNode as unknown as { range: [number, number] }).range;
      const insertPoint = nextLineOffset(luaSource, insertAfterRange[1]);

      // Combine all insertions into a single replacement to maintain order
      const hoistCode = toInsert.map((name) => `local ${name} = ${moduleVar}.${name}`).join("\n");
      edits.push({
        offset: insertPoint,
        length: 0,
        replacement: hoistCode + "\n",
      });
    }
  }

  // Collect access references to rewrite
  const references = collectAccessReferences(ast, requireInfos, accessesToHoist);

  for (const ref of references) {
    edits.push({
      offset: ref.offset,
      length: ref.length,
      replacement: ref.name,
    });
  }

  // Apply edits in reverse offset order
  const transformedSource = applyEdits(luaSource, edits);

  return {
    source: transformedSource,
    localizedSymbols,
  };
}

function nextLineOffset(source: string, rangeEnd: number): number {
  const nl = source.indexOf("\n", rangeEnd);
  return nl === -1 ? source.length : nl + 1;
}

function applyEdits(source: string, edits: Edit[]): string {
  edits.sort((a, b) => b.offset - a.offset);
  let result = source;
  for (const { offset, length, replacement } of edits) {
    result = result.slice(0, offset) + replacement + result.slice(offset + length);
  }
  return result;
}

interface AccessReference {
  offset: number;
  length: number;
  name: string;
}

function collectAccessReferences(
  node: luaparse.Node,
  requireInfos: Map<string, RequireInfo>,
  accessesToHoist: Map<string, { moduleVar: string; order: number }>,
): AccessReference[] {
  const references: AccessReference[] = [];
  const declarationLhses = new Set<luaparse.Node>();

  walkAstNode(node, (n) => {
    if (n.type === "FunctionDeclaration") {
      const func = n as luaparse.FunctionDeclaration;
      if (func.identifier && func.identifier.type === "MemberExpression") {
        declarationLhses.add(func.identifier);
      }
    } else if (n.type === "AssignmentStatement") {
      const assign = n as luaparse.AssignmentStatement;
      for (const variable of assign.variables) {
        if (variable.type === "MemberExpression") {
          declarationLhses.add(variable);
        }
      }
    }
  });

  walkAstNode(node, (n) => {
    if (n.type === "MemberExpression" && !declarationLhses.has(n as luaparse.Node)) {
      const member = n as luaparse.MemberExpression;
      if (member.base.type === "Identifier") {
        const moduleVar = (member.base as luaparse.Identifier).name;
        if (requireInfos.has(moduleVar)) {
          const memberName = (member.identifier as luaparse.Identifier).name;
          if (accessesToHoist.has(memberName)) {
            const range = (n as unknown as { range: [number, number] }).range;
            references.push({
              offset: range[0],
              length: range[1] - range[0],
              name: memberName,
            });
          }
        }
      }
    }
  });

  return references;
}
