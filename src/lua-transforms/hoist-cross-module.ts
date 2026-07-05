import type luaparse from "luaparse";
import { applyEdits, type Edit, nextLineOffset, nodeRange, walkAstNode } from "./ast-utils.js";
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

  const requireBindings = collectRequireBindings(ast);
  if (requireBindings.size === 0) {
    return {
      source: luaSource,
      localizedSymbols: new Map(),
    };
  }

  const requireInfos = buildRequireInfos(ast, requireBindings);
  const preExistingHoists = collectPreExistingHoists(ast, requireInfos);
  const declarationLhses = collectDeclarationLhses(ast);
  const accessesToHoist = collectAccessesToHoist(
    ast,
    requireInfos,
    preExistingHoists,
    collectExistingLocals(ast),
    declarationLhses,
  );

  const { edits, localizedSymbols } = buildHoistEdits(
    luaSource,
    requireInfos,
    preExistingHoists,
    accessesToHoist,
  );

  const references = collectAccessReferences(ast, requireInfos, accessesToHoist, declarationLhses);
  for (const ref of references) {
    edits.push({
      offset: ref.offset,
      length: ref.length,
      replacement: ref.name,
    });
  }

  return {
    source: applyEdits(luaSource, edits),
    localizedSymbols,
  };
}

function buildRequireInfos(
  ast: luaparse.Chunk,
  requireBindings: ReadonlyMap<string, { node: luaparse.LocalStatement; path: string }>,
): Map<string, RequireInfo> {
  const requireInfos = new Map<string, RequireInfo>();
  for (const [moduleVar, binding] of requireBindings) {
    const index = ast.body.indexOf(binding.node);
    if (index >= 0) {
      requireInfos.set(moduleVar, {
        statement: binding.node,
        index,
        moduleVar,
        path: binding.path,
      });
    }
  }
  return requireInfos;
}

/** Collects consecutive `local foo = ____mod.foo` hoists already present after each require. */
function collectPreExistingHoists(
  ast: luaparse.Chunk,
  requireInfos: ReadonlyMap<string, RequireInfo>,
): Map<string, PreExistingHoist[]> {
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
  return preExistingHoists;
}

function matchRequireMember(
  node: luaparse.Node,
  requireInfos: ReadonlyMap<string, RequireInfo>,
  declarationLhses: ReadonlySet<luaparse.Node>,
): { member: luaparse.MemberExpression; moduleVar: string; memberName: string } | undefined {
  if (node.type !== "MemberExpression" || declarationLhses.has(node)) return undefined;
  const member = node as luaparse.MemberExpression;
  if (member.base.type !== "Identifier") return undefined;
  const moduleVar = (member.base as luaparse.Identifier).name;
  if (!requireInfos.has(moduleVar)) return undefined;
  return { member, moduleVar, memberName: (member.identifier as luaparse.Identifier).name };
}

/**
 * Scans the AST for member accesses on required modules and returns the first-access
 * order for each name. Throws on collisions: two modules contributing the same member
 * name, or a hoisted name shadowing an existing chunk-level local.
 */
function collectAccessesToHoist(
  ast: luaparse.Chunk,
  requireInfos: ReadonlyMap<string, RequireInfo>,
  preExistingHoists: ReadonlyMap<string, PreExistingHoist[]>,
  existingLocals: ReadonlySet<string>,
  declarationLhses: ReadonlySet<luaparse.Node>,
): Map<string, { moduleVar: string; order: number }> {
  const memberAccesses: Array<{ name: string; moduleVar: string; offset: number }> = [];

  walkAstNode(ast, (node) => {
    const match = matchRequireMember(node, requireInfos, declarationLhses);
    if (match) {
      const preExisting = preExistingHoists.get(match.moduleVar);
      if (!preExisting?.some((h) => h.name === match.memberName)) {
        const offset = nodeRange(match.member)[0];
        memberAccesses.push({ name: match.memberName, moduleVar: match.moduleVar, offset });
      }
    }
  });

  // Sort by source offset to get first-access order
  memberAccesses.sort((a, b) => a.offset - b.offset);

  const accessesToHoist = new Map<string, { moduleVar: string; order: number }>();
  const accessesByModule = new Map<string, Set<string>>();
  for (let i = 0; i < memberAccesses.length; i++) {
    const { name, moduleVar } = memberAccesses[i];
    if (!accessesToHoist.has(name)) {
      accessesToHoist.set(name, { moduleVar, order: i });
    }
    let moduleSet = accessesByModule.get(name);
    if (!moduleSet) {
      moduleSet = new Set();
      accessesByModule.set(name, moduleSet);
    }
    moduleSet.add(moduleVar);
  }

  for (const [name] of accessesToHoist) {
    const moduleSet = accessesByModule.get(name);
    if (moduleSet && moduleSet.size > 1) {
      const mods = Array.from(moduleSet);
      throw new Error(
        `Collision: member name "${name}" contributed by multiple modules: ${mods.join(", ")}`,
      );
    }

    if (existingLocals.has(name)) {
      throw new Error(`Collision: hoisted name "${name}" shadows existing chunk-level local`);
    }
  }

  return accessesToHoist;
}

/** Builds the `local name = moduleVar.name` insertion edits and the resulting symbol map. */
function buildHoistEdits(
  luaSource: string,
  requireInfos: ReadonlyMap<string, RequireInfo>,
  preExistingHoists: ReadonlyMap<string, PreExistingHoist[]>,
  accessesToHoist: ReadonlyMap<string, { moduleVar: string; order: number }>,
): { edits: Edit[]; localizedSymbols: Map<string, { moduleVar: string; memberName: string }> } {
  const edits: Edit[] = [];
  const localizedSymbols = new Map<string, { moduleVar: string; memberName: string }>();

  for (const [moduleVar, hoists] of preExistingHoists) {
    for (const hoist of hoists) {
      localizedSymbols.set(hoist.name, { moduleVar, memberName: hoist.name });
    }
  }

  for (const [moduleVar, info] of requireInfos) {
    const preExisting = preExistingHoists.get(moduleVar);

    const toInsertUnsorted: Array<{ name: string; order: number }> = [];
    for (const [name, { moduleVar: originModule, order }] of accessesToHoist) {
      if (originModule === moduleVar) {
        if (!preExisting?.some((h) => h.name === name)) {
          toInsertUnsorted.push({ name, order });
          localizedSymbols.set(name, { moduleVar, memberName: name });
        }
      }
    }

    const toInsert = toInsertUnsorted.sort((a, b) => a.order - b.order).map((x) => x.name);

    if (toInsert.length > 0) {
      let insertAfterNode = info.statement;
      if (preExisting && preExisting.length > 0) {
        insertAfterNode = preExisting[preExisting.length - 1].node;
      }

      const insertAfterRange = nodeRange(insertAfterNode);
      const insertPoint = nextLineOffset(luaSource, insertAfterRange[1]);

      const hoistCode = toInsert.map((name) => `local ${name} = ${moduleVar}.${name}`).join("\n");
      // If inserting mid-line (no newline before insertion point), prepend newline
      const needsLeadingNewline = insertPoint > 0 && luaSource[insertPoint - 1] !== "\n";
      const replacement = needsLeadingNewline ? `\n${hoistCode}\n` : `${hoistCode}\n`;
      edits.push({
        offset: insertPoint,
        length: 0,
        replacement,
      });
    }
  }

  return { edits, localizedSymbols };
}

function collectDeclarationLhses(root: luaparse.Node): Set<luaparse.Node> {
  const lhses = new Set<luaparse.Node>();
  walkAstNode(root, (n) => {
    if (n.type === "FunctionDeclaration") {
      const func = n as luaparse.FunctionDeclaration;
      if (func.identifier && func.identifier.type === "MemberExpression") {
        lhses.add(func.identifier);
      }
    } else if (n.type === "AssignmentStatement") {
      const assign = n as luaparse.AssignmentStatement;
      for (const variable of assign.variables) {
        if (variable.type === "MemberExpression") {
          lhses.add(variable);
        }
      }
    }
  });
  return lhses;
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
  declarationLhses: Set<luaparse.Node>,
): AccessReference[] {
  const references: AccessReference[] = [];

  walkAstNode(node, (n) => {
    const match = matchRequireMember(n, requireInfos, declarationLhses);
    if (match && accessesToHoist.has(match.memberName)) {
      const range = nodeRange(n);
      references.push({
        offset: range[0],
        length: range[1] - range[0],
        name: match.memberName,
      });
    }
  });

  return references;
}
