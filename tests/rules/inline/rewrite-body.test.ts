import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { LiteralKind } from "../../../src/rules/inline/const-literal";
import { rewriteWithConstSubstitutions } from "../../../src/rules/inline/rewrite-body";
import { findNode, makeChecker } from "./helpers";

function getSymbol(sourceFile: ts.SourceFile, checker: ts.TypeChecker, name: string): ts.Symbol {
  const declaration = findNode(
    sourceFile,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  if (!declaration) throw new Error(`expected ${name} declaration`);
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) throw new Error(`expected ${name} symbol`);
  return symbol;
}

describe("rewriteWithConstSubstitutions", () => {
  it("returns the original node when no substitutions are available", () => {
    const { checker } = makeChecker("const X = 1;");
    const node = ts.factory.createNumericLiteral("1");

    expect(rewriteWithConstSubstitutions(node, new Map(), checker)).toBe(node);
  });

  it("leaves type nodes unchanged", () => {
    const { checker, sourceFile } = makeChecker("const X = 1;");
    const symbol = getSymbol(sourceFile, checker, "X");
    const substitutions = new Map<ts.Symbol, LiteralKind>([[symbol, { kind: "number", value: 1 }]]);
    const node = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);

    expect(rewriteWithConstSubstitutions(node, substitutions, checker)).toBe(node);
  });

  it("rewrites computed property names and values", () => {
    const { checker, sourceFile } = makeChecker(`
      const KEY = "answer";
      const VALUE = 42;
      const result = { [KEY]: VALUE };
    `);
    const keySymbol = getSymbol(sourceFile, checker, "KEY");
    const valueSymbol = getSymbol(sourceFile, checker, "VALUE");
    const objectLiteral = findNode(sourceFile, ts.isObjectLiteralExpression);
    if (!objectLiteral) throw new Error("expected object literal");
    const substitutions = new Map<ts.Symbol, LiteralKind>([
      [keySymbol, { kind: "string", value: "answer" }],
      [valueSymbol, { kind: "number", value: 42 }],
    ]);

    const result = rewriteWithConstSubstitutions(objectLiteral, substitutions, checker);
    const property = result.properties[0];
    if (!property || !ts.isPropertyAssignment(property)) {
      throw new Error("expected property assignment");
    }

    if (!ts.isComputedPropertyName(property.name)) {
      throw new Error("expected computed property name");
    }
    expect(ts.isStringLiteral(property.name.expression)).toBe(true);
    expect(ts.isNumericLiteral(property.initializer)).toBe(true);
  });

  it("rewrites plain property assignment values", () => {
    const { checker, sourceFile } = makeChecker(`
      const VALUE = 42;
      const result = { answer: VALUE };
    `);
    const valueSymbol = getSymbol(sourceFile, checker, "VALUE");
    const objectLiteral = findNode(sourceFile, ts.isObjectLiteralExpression);
    if (!objectLiteral) throw new Error("expected object literal");
    const substitutions = new Map<ts.Symbol, LiteralKind>([
      [valueSymbol, { kind: "number", value: 42 }],
    ]);

    const result = rewriteWithConstSubstitutions(objectLiteral, substitutions, checker);
    const property = result.properties[0];
    if (!property || !ts.isPropertyAssignment(property)) {
      throw new Error("expected property assignment");
    }

    expect(ts.isIdentifier(property.name)).toBe(true);
    expect(ts.isNumericLiteral(property.initializer)).toBe(true);
  });

  it("keeps unmatched shorthand properties as shorthand", () => {
    const { checker, sourceFile } = makeChecker(`
      const X = 1;
      const Y = 2;
      const result = { X };
    `);
    const symbol = getSymbol(sourceFile, checker, "Y");
    const objectLiteral = findNode(sourceFile, ts.isObjectLiteralExpression);
    if (!objectLiteral) throw new Error("expected object literal");
    const substitutions = new Map<ts.Symbol, LiteralKind>([[symbol, { kind: "number", value: 2 }]]);

    const result = rewriteWithConstSubstitutions(objectLiteral, substitutions, checker);

    expect(ts.isShorthandPropertyAssignment(result.properties[0])).toBe(true);
  });

  it("keeps synthetic shorthand properties without symbols", () => {
    const { checker, sourceFile } = makeChecker("const VALUE = 2;");
    const symbol = getSymbol(sourceFile, checker, "VALUE");
    const shorthand = ts.factory.createShorthandPropertyAssignment(
      ts.factory.createIdentifier("MISSING"),
      ts.factory.createNumericLiteral("1"),
    );
    const substitutions = new Map<ts.Symbol, LiteralKind>([[symbol, { kind: "number", value: 2 }]]);

    const result = rewriteWithConstSubstitutions(shorthand, substitutions, checker);

    expect(ts.isShorthandPropertyAssignment(result)).toBe(true);
  });
});
