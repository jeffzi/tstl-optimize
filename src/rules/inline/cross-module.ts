import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import { unwrapTransparent } from "../../ast/ts-ast";
import {
  type ImportBinding,
  type LiteralKind,
  resolveConstLiteral,
  resolveRequireChain,
} from "./const-literal";
import { createInlineWarning, InlineDiagnosticCode } from "./diagnostics";
import type { InlineTarget } from "./target";

// ---------------------------------------------------------------------------
// Free-variable detection
// ---------------------------------------------------------------------------

const CROSS_MODULE_WARNING_MESSAGE = "cross-module function references non-parameter identifiers";

export function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- parent can be undefined at runtime (SourceFile root)
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function hasCrossModuleFreeVariable(
  nodes: readonly ts.Node[],
  params: readonly ts.ParameterDeclaration[],
  sourceDeclaration: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const { blocking } = classifyCrossModuleFreeVariables(nodes, params, sourceDeclaration, checker);
  return blocking.length > 0;
}

// ---------------------------------------------------------------------------
// Identifier classification
// ---------------------------------------------------------------------------

interface CrossModuleFreeVariableClassification {
  blocking: ts.Identifier[];
  substitutions: Map<ts.Symbol, LiteralKind>;
  imports: Map<ts.Symbol, ImportBinding>;
  ambients: Set<ts.Symbol>;
}

function getParamSymbols(
  params: readonly ts.ParameterDeclaration[],
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  return new Set(
    params
      .map((param) => checker.getSymbolAtLocation(param.name))
      .filter((symbol): symbol is ts.Symbol => symbol !== undefined),
  );
}

function isSameFileNonDescendant(
  declaration: ts.Declaration,
  sourceFile: ts.SourceFile,
  sourceDeclaration: ts.Node,
): boolean {
  return (
    declaration.getSourceFile() === sourceFile && !isDescendant(declaration, sourceDeclaration)
  );
}

function classifyAliasedIdentifier(
  symbol: ts.Symbol,
  node: ts.Identifier,
  checker: ts.TypeChecker,
  classification: CrossModuleFreeVariableClassification,
  allowSubstitution: boolean,
): boolean {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return false;

  const aliasedSymbol = checker.getAliasedSymbol(symbol);
  const literal = resolveConstLiteral(aliasedSymbol, checker);
  if (literal !== undefined && allowSubstitution) {
    classification.substitutions.set(aliasedSymbol, literal);
    return true;
  }

  const importBinding = resolveRequireChain(aliasedSymbol, checker);
  if (importBinding !== undefined) {
    classification.imports.set(aliasedSymbol, importBinding);
    return true;
  }

  classification.blocking.push(node);
  return true;
}

function classifySameFileIdentifier(
  symbol: ts.Symbol,
  node: ts.Identifier,
  sourceFile: ts.SourceFile,
  sourceDeclaration: ts.Node,
  classification: CrossModuleFreeVariableClassification,
  allowSubstitution: boolean,
  checker: ts.TypeChecker,
): boolean {
  const declarations = symbol.getDeclarations();
  /* v8 ignore next -- checker symbols for source identifiers have declarations */
  if (declarations === undefined) return false;

  for (const declaration of declarations) {
    if (!isSameFileNonDescendant(declaration, sourceFile, sourceDeclaration)) continue;

    const literal = resolveConstLiteral(symbol, checker);
    if (allowSubstitution && literal !== undefined && ts.isVariableDeclaration(declaration)) {
      classification.substitutions.set(symbol, literal);
      return true;
    }

    const importBinding = resolveRequireChain(symbol, checker);
    if (importBinding !== undefined) {
      classification.imports.set(symbol, importBinding);
      return true;
    }

    classification.blocking.push(node);
    return true;
  }

  return false;
}

function hasExternalValueDeclaration(symbol: ts.Symbol, sourceFile: ts.SourceFile): boolean {
  const declarations = symbol.getDeclarations();
  if (declarations === undefined) return false;

  return declarations.some((declaration) => declaration.getSourceFile() !== sourceFile);
}

function hasNoValueDeclaration(symbol: ts.Symbol): boolean {
  return symbol.getDeclarations() === undefined;
}

function isAmbientGlobalSymbol(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations();
  if (declarations === undefined || declarations.length === 0) return false;
  return declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

function hasRuntimeDeclaration(symbol: ts.Symbol): boolean {
  return symbol.getDeclarations()?.some((d) => !d.getSourceFile().isDeclarationFile) === true;
}

function isAllowedExternalIdentifier(node: ts.Identifier): boolean {
  return node.text === "$multi";
}

function classifyIdentifierSymbol(
  symbol: ts.Symbol,
  node: ts.Identifier,
  sourceFile: ts.SourceFile,
  sourceDeclaration: ts.Node,
  checker: ts.TypeChecker,
  paramSymbols: Set<ts.Symbol>,
  classification: CrossModuleFreeVariableClassification,
  allowSubstitution = true,
): void {
  if (paramSymbols.has(symbol)) return;

  if (classifyAliasedIdentifier(symbol, node, checker, classification, allowSubstitution)) return;

  if (
    classifySameFileIdentifier(
      symbol,
      node,
      sourceFile,
      sourceDeclaration,
      classification,
      allowSubstitution,
      checker,
    )
  ) {
    return;
  }

  if (isAllowedExternalIdentifier(node)) return;

  if (isAmbientGlobalSymbol(symbol)) {
    classification.ambients.add(symbol);
    return;
  }

  if (hasExternalValueDeclaration(symbol, sourceFile) || hasNoValueDeclaration(symbol)) {
    classification.blocking.push(node);
  }
}

export function classifyCrossModuleFreeVariables(
  nodes: readonly ts.Node[],
  params: readonly ts.ParameterDeclaration[],
  sourceDeclaration: ts.Node,
  checker: ts.TypeChecker,
): CrossModuleFreeVariableClassification {
  const sourceFile = sourceDeclaration.getSourceFile();
  const paramSymbols = getParamSymbols(params, checker);

  const classification: CrossModuleFreeVariableClassification = {
    blocking: [],
    substitutions: new Map<ts.Symbol, LiteralKind>(),
    imports: new Map<ts.Symbol, ImportBinding>(),
    ambients: new Set<ts.Symbol>(),
  };

  function classifyResolvedIdentifier(
    symbol: ts.Symbol | undefined,
    node: ts.Identifier,
    allowSubstitution: boolean,
  ): void {
    if (symbol === undefined) {
      classification.blocking.push(node);
      return;
    }

    classifyIdentifierSymbol(
      symbol,
      node,
      sourceFile,
      sourceDeclaration,
      checker,
      paramSymbols,
      classification,
      allowSubstitution,
    );
  }

  function walk(node: ts.Node, allowSubstitution = true): void {
    if (ts.isTypeNode(node)) return;

    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unwrapTransparent(node.expression);
      if (ts.isIdentifier(receiver)) {
        classifyResolvedIdentifier(checker.getSymbolAtLocation(receiver), receiver, false);
        return;
      }
      walk(node.expression, allowSubstitution);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      walk(node.expression, false);
      walk(node.argumentExpression, false);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) {
        walk(node.name.expression, allowSubstitution);
      }
      walk(node.initializer, allowSubstitution);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      classifyResolvedIdentifier(
        checker.getShorthandAssignmentValueSymbol(node) ?? checker.getSymbolAtLocation(node.name),
        node.name,
        allowSubstitution,
      );
      if (node.objectAssignmentInitializer) {
        walk(node.objectAssignmentInitializer, allowSubstitution);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      classifyResolvedIdentifier(checker.getSymbolAtLocation(node), node, allowSubstitution);
    }
    ts.forEachChild(node, (child) => walk(child, allowSubstitution));
  }

  for (const node of nodes) {
    walk(node);
  }
  return classification;
}

function isAmbientShadowedAtCallSite(
  ambientSymbol: ts.Symbol,
  callNode: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const name = ambientSymbol.getName();
  const localSymbols = checker.getSymbolsInScope(
    callNode,
    ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
  );
  return localSymbols.some(
    (scopedSymbol) =>
      scopedSymbol !== ambientSymbol &&
      scopedSymbol.getName() === name &&
      isValueSpaceSymbol(scopedSymbol, checker) &&
      hasRuntimeDeclaration(scopedSymbol),
  );
}

function isTypeOnlyAliasDeclaration(declaration: ts.Declaration): boolean {
  return ts.isTypeOnlyImportDeclaration(declaration) || ts.isTypeOnlyExportDeclaration(declaration);
}

function isValueSpaceSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) return true;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return false;

  const declarations = symbol.getDeclarations();
  if (declarations?.every(isTypeOnlyAliasDeclaration) === true) {
    return false;
  }

  return (checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.Value) !== 0;
}

function createCrossModuleRejection(
  callNode: ts.CallExpression,
  context: tstl.TransformationContext,
  strict: boolean,
  warnCrossModule: boolean,
): { reject: true } {
  if (warnCrossModule) {
    context.diagnostics.push(
      createInlineWarning(
        callNode,
        CROSS_MODULE_WARNING_MESSAGE,
        strict,
        InlineDiagnosticCode.crossModule,
      ),
    );
  }
  return { reject: true };
}

// ---------------------------------------------------------------------------
// Cross-module inline resolution
// ---------------------------------------------------------------------------

/**
 * For each entry in `imports` (keyed by underlying target-module symbol → ImportBinding),
 * check whether the consumer has an in-scope alias at `callNode` that resolves to the
 * same underlying symbol (i.e. both import the same export from the same module).
 *
 * Returns a map from target alias symbol → consumer alias symbol for every matched pair.
 * Unmatched imports are absent from the result (they will still be synthesized as
 * `require("path").member` chains by the rewrite step).
 */
export function resolveConsumerBindings(
  imports: ReadonlyMap<ts.Symbol, ImportBinding>,
  callNode: ts.Node,
  checker: ts.TypeChecker,
): Map<ts.Symbol, ts.Symbol> {
  const result = new Map<ts.Symbol, ts.Symbol>();
  if (imports.size === 0) return result;

  const consumerSymbols = checker.getSymbolsInScope(
    callNode,
    ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
  );

  for (const [targetSymbol] of imports) {
    for (const consumerSymbol of consumerSymbols) {
      if ((consumerSymbol.flags & ts.SymbolFlags.Alias) === 0) continue;
      if (!isValueSpaceSymbol(consumerSymbol, checker)) continue;
      if (!hasRuntimeDeclaration(consumerSymbol)) continue;

      // Both the target symbol (stored as aliased symbol in `imports`) and the consumer
      // symbol (an import alias in the consumer module) must resolve to the same underlying
      // export.  `targetSymbol` is already the aliased (underlying) symbol; unwrap the
      // consumer alias to compare.
      if (checker.getAliasedSymbol(consumerSymbol) === targetSymbol) {
        result.set(targetSymbol, consumerSymbol);
        break;
      }
    }
  }

  return result;
}

export function classifyCrossModuleInline(
  callNode: ts.CallExpression,
  target: InlineTarget,
  nodes: readonly ts.Node[],
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
  warnCrossModule: boolean,
):
  | { reject: true }
  | {
      reject: false;
      substitutions: Map<ts.Symbol, LiteralKind>;
      imports: Map<ts.Symbol, ImportBinding>;
    } {
  const isCrossModule =
    callNode.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;

  if (!isCrossModule) {
    return { reject: false, substitutions: new Map(), imports: new Map() };
  }

  const { blocking, substitutions, imports, ambients } = classifyCrossModuleFreeVariables(
    nodes,
    target.params,
    target.declaration,
    checker,
  );

  if (blocking.length > 0) {
    return createCrossModuleRejection(callNode, context, strict, warnCrossModule);
  }

  for (const symbol of ambients) {
    if (isAmbientShadowedAtCallSite(symbol, callNode, checker)) {
      return createCrossModuleRejection(callNode, context, strict, warnCrossModule);
    }
  }

  return { reject: false, substitutions, imports };
}
