import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { Walk, walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";
import { extractRequirePattern, mapLuaStatements } from "./inline/lua-substitute";
import { allocateHoistName } from "./localizer/hoist";
import { transformSourceFile } from "./source-file";

function requirePatternKey(requirePath: string, memberName: string | undefined): string {
  return memberName !== undefined ? `${requirePath}:${memberName}` : requirePath;
}

function requireLocalBaseName(requirePath: string, memberName: string | undefined): string {
  const safePath = requirePath.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeMember =
    memberName !== undefined ? `_${memberName.replace(/[^a-zA-Z0-9_]/g, "_")}` : "";
  return `____req_${safePath}${safeMember}`;
}

interface RequireOccurrence {
  count: number;
  requirePath: string;
  memberName: string | undefined;
  /** First expression node found — used as the hoisted initializer. */
  firstExpr: tstl.Expression;
}

function collectScopedRequirePatterns(
  statements: readonly tstl.Statement[],
): Map<string, RequireOccurrence> {
  const occurrences = new Map<string, RequireOccurrence>();

  walkStatements(statements, {
    shallow: true,
    expr: (expr: tstl.Expression) => {
      const pattern = extractRequirePattern(expr);
      if (pattern === undefined) {
        return Walk.keep;
      }
      const key = requirePatternKey(pattern.requirePath, pattern.memberName);
      const existing = occurrences.get(key);
      if (existing !== undefined) {
        existing.count++;
      } else {
        occurrences.set(key, {
          count: 1,
          requirePath: pattern.requirePath,
          memberName: pattern.memberName,
          firstExpr: expr,
        });
      }
      // Do not recurse into a matched pattern — its sub-expressions are part
      // of the pattern and must not be counted again.
      return Walk.skip;
    },
  });

  return occurrences;
}

function hoistRequireInScope(
  statements: tstl.Statement[],
  context: tstl.TransformationContext,
): void {
  const occurrences = collectScopedRequirePatterns(statements);

  // Collect the set of existing names in these statements to avoid collisions.
  const existingNames = new Set<string>();
  walkStatements(statements, {
    shallow: true,
    expr: (expr: tstl.Expression) => {
      if (tstl.isIdentifier(expr) && expr.text !== undefined) {
        existingNames.add(expr.text);
      }
      return Walk.keep;
    },
  });

  const replacements = new Map<string, tstl.Identifier>();
  const hoistedDecls: tstl.VariableDeclarationStatement[] = [];

  for (const [key, { count, requirePath, memberName, firstExpr }] of occurrences) {
    if (count < 2) continue;

    const baseName = requireLocalBaseName(requirePath, memberName);
    const hoistName = allocateHoistName(baseName, existingNames);
    existingNames.add(hoistName);

    const ident = tstl.createIdentifier(hoistName, undefined, context.nextSymbolId());
    replacements.set(key, ident);

    const decl = tstl.createVariableDeclarationStatement([ident], [firstExpr]);
    hoistedDecls.push(decl);
  }

  if (replacements.size === 0) return;

  // Replace all occurrences of the matched patterns with the hoisted identifiers.
  // mapLuaStatements recurses into all sub-expressions including nested function
  // bodies — for the replacement pass this is safe because:
  //   - We only replace the exact pattern (require("path") or require("path").member)
  //   - Nested function bodies that use the same pattern benefit from the outer hoist
  //     (they will close over the local, which is correct and is the same semantics)
  const replaceFn = (expr: tstl.Expression): tstl.Expression | undefined => {
    const pattern = extractRequirePattern(expr);
    if (pattern === undefined) return undefined;
    const key = requirePatternKey(pattern.requirePath, pattern.memberName);
    const ident = replacements.get(key);
    if (ident === undefined) return undefined;
    return tstl.cloneNode(ident);
  };

  const rewritten = mapLuaStatements(statements, replaceFn);
  statements.splice(0, statements.length, ...rewritten);
  statements.unshift(...hoistedDecls);
}

function hoistFunctionBodies(
  statements: readonly tstl.Statement[],
  context: tstl.TransformationContext,
): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr: tstl.Expression) => {
      if (tstl.isFunctionExpression(expr)) {
        hoistFunctionBodies(expr.body.statements, context);
        hoistRequireInScope(expr.body.statements, context);
        return Walk.skip;
      }
      return Walk.keep;
    },
  });
}

function processFile(file: tstl.File, context: tstl.TransformationContext): void {
  hoistFunctionBodies(file.statements, context);
  hoistRequireInScope(file.statements, context);
}

export const createVisitors: RuleFactory = (_checker, config) => {
  if (config.rules["hoist-require"] === false) return {};

  return {
    [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context: tstl.TransformationContext) => {
      const file = transformSourceFile(node, context);
      processFile(file, context);
      return file;
    },
  };
};
