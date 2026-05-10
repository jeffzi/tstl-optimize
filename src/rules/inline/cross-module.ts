import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import {
  type LiteralKind,
  resolveConstLiteral,
  unwrapTransparentExpression,
} from "./const-literal";
import { createInlineWarning, InlineDiagnosticCode } from "./diagnostics";
import type { InlineTarget } from "./target";

export function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
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

interface CrossModuleFreeVariableClassification {
  blocking: ts.Identifier[];
  substitutions: Map<ts.Symbol, LiteralKind>;
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

function getVariableStatement(declaration: ts.Declaration): ts.VariableStatement | undefined {
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList)) return undefined;

  const statement = declarationList.parent;
  return ts.isVariableStatement(statement) ? statement : undefined;
}

function isExportedVariableDeclaration(declaration: ts.VariableDeclaration): boolean {
  const statement = getVariableStatement(declaration);
  /* v8 ignore next -- module-scope variable declarations have variable statements */
  if (!statement) return false;

  if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return true;
  }

  /* v8 ignore next -- const literal substitutions only resolve identifier declarations */
  if (!ts.isIdentifier(declaration.name)) return false;
  const localName = declaration.name.text;
  return statement
    .getSourceFile()
    .statements.some(
      (sourceStatement) =>
        ts.isExportDeclaration(sourceStatement) &&
        sourceStatement.exportClause &&
        ts.isNamedExports(sourceStatement.exportClause) &&
        sourceStatement.exportClause.elements.some(
          (element) => (element.propertyName?.text ?? element.name.text) === localName,
        ),
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
  } else {
    classification.blocking.push(node);
  }
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
    if (
      allowSubstitution &&
      literal !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      isExportedVariableDeclaration(declaration)
    ) {
      classification.substitutions.set(symbol, literal);
    } else {
      classification.blocking.push(node);
    }
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

  if (!classifyAliasedIdentifier(symbol, node, checker, classification, allowSubstitution)) {
    const handled = classifySameFileIdentifier(
      symbol,
      node,
      sourceFile,
      sourceDeclaration,
      classification,
      allowSubstitution,
      checker,
    );
    if (
      !handled &&
      !isAllowedExternalIdentifier(node) &&
      (hasExternalValueDeclaration(symbol, sourceFile) || hasNoValueDeclaration(symbol))
    ) {
      classification.blocking.push(node);
    }
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
      const receiver = unwrapTransparentExpression(node.expression);
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

export function classifyCrossModuleInline(
  callNode: ts.CallExpression,
  target: InlineTarget,
  nodes: readonly ts.Node[],
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): { reject: true } | { reject: false; substitutions: Map<ts.Symbol, LiteralKind> } {
  const isCrossModule =
    callNode.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;

  if (!isCrossModule) {
    return { reject: false, substitutions: new Map() };
  }

  const { blocking, substitutions } = classifyCrossModuleFreeVariables(
    nodes,
    target.params,
    target.declaration,
    checker,
  );

  if (blocking.length > 0) {
    context.diagnostics.push(
      createInlineWarning(
        callNode,
        "cross-module function references non-parameter identifiers",
        strict,
        InlineDiagnosticCode.crossModule,
      ),
    );
    return { reject: true };
  }

  return { reject: false, substitutions };
}
