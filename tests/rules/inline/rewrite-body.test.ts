import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ImportBinding, LiteralKind } from "../../../src/rules/inline/const-literal";
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

    const prop0 = result.properties[0];
    if (!prop0) return;
    expect(ts.isShorthandPropertyAssignment(prop0)).toBe(true);
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

  describe("import substitution via imports map", () => {
    it("returns the original node when both substitutions and imports are empty", () => {
      const { checker } = makeChecker("const X = 1;");
      const node = ts.factory.createNumericLiteral("1");

      const result = rewriteWithConstSubstitutions(node, new Map(), checker, new Map());

      expect(result).toBe(node);
    });

    it("rewrites an identifier mapped to an import binding with a member to require().member", () => {
      const { checker, sourceFile } = makeChecker(`
        declare const band: unknown;
        const x = band;
      `);
      const bandSymbol = getSymbol(sourceFile, checker, "band");
      const binding: ImportBinding = { requirePath: "bit", memberName: "band" };
      const imports = new Map<ts.Symbol, ImportBinding>([[bandSymbol, binding]]);

      const xDecl = findNode(
        sourceFile,
        (n): n is ts.VariableDeclaration =>
          ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "x",
      );
      if (!xDecl?.initializer) throw new Error("expected x declaration with initializer");

      const result = rewriteWithConstSubstitutions(xDecl.initializer, new Map(), checker, imports);

      expect(ts.isPropertyAccessExpression(result)).toBe(true);
      const propAccess = result as ts.PropertyAccessExpression;
      expect(ts.isCallExpression(propAccess.expression)).toBe(true);
      const call = propAccess.expression as ts.CallExpression;
      expect(ts.isIdentifier(call.expression) && (call.expression as ts.Identifier).text).toBe(
        "require",
      );
      const arg0 = call.arguments[0];
      expect(arg0 ? ts.isStringLiteral(arg0) && (arg0 as ts.StringLiteral).text : false).toBe(
        "bit",
      );
      expect(propAccess.name.text).toBe("band");
    });

    it("rewrites an identifier mapped to a bare import binding to require()", () => {
      const { checker, sourceFile } = makeChecker(`
        declare const bit: unknown;
        const x = bit;
      `);
      const bitSymbol = getSymbol(sourceFile, checker, "bit");
      const binding: ImportBinding = { requirePath: "bit", memberName: undefined };
      const imports = new Map<ts.Symbol, ImportBinding>([[bitSymbol, binding]]);

      const xDecl = findNode(
        sourceFile,
        (n): n is ts.VariableDeclaration =>
          ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "x",
      );
      if (!xDecl?.initializer) throw new Error("expected x declaration with initializer");

      const result = rewriteWithConstSubstitutions(xDecl.initializer, new Map(), checker, imports);

      expect(ts.isCallExpression(result)).toBe(true);
      const call = result as ts.CallExpression;
      expect(ts.isIdentifier(call.expression) && (call.expression as ts.Identifier).text).toBe(
        "require",
      );
      const arg = call.arguments[0];
      expect(arg ? ts.isStringLiteral(arg) && (arg as ts.StringLiteral).text : false).toBe("bit");
    });

    it("literal substitution takes priority over import substitution for the same symbol", () => {
      const { checker, sourceFile } = makeChecker(`
        declare const x: unknown;
        const y = x;
      `);
      const xSymbol = getSymbol(sourceFile, checker, "x");
      const substitutions = new Map<ts.Symbol, LiteralKind>([
        [xSymbol, { kind: "number", value: 42 }],
      ]);
      const imports = new Map<ts.Symbol, ImportBinding>([
        [xSymbol, { requirePath: "bit", memberName: "band" }],
      ]);

      const yDecl = findNode(
        sourceFile,
        (n): n is ts.VariableDeclaration =>
          ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "y",
      );
      if (!yDecl?.initializer) throw new Error("expected y declaration with initializer");

      const result = rewriteWithConstSubstitutions(
        yDecl.initializer,
        substitutions,
        checker,
        imports,
      );

      // Should be a numeric literal (42), not a require() expression
      expect(ts.isNumericLiteral(result)).toBe(true);
      expect((result as ts.NumericLiteral).text).toBe("42");
    });

    it("applies import substitutions when substitutions is empty", () => {
      const { checker, sourceFile } = makeChecker(`
        declare const x: unknown;
        const y = x;
      `);
      const xSymbol = getSymbol(sourceFile, checker, "x");
      const imports = new Map<ts.Symbol, ImportBinding>([
        [xSymbol, { requirePath: "mymod", memberName: "fn" }],
      ]);

      const yDecl = findNode(
        sourceFile,
        (n): n is ts.VariableDeclaration =>
          ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "y",
      );
      if (!yDecl?.initializer) throw new Error("expected y declaration with initializer");

      // Empty substitutions but non-empty imports — the fast path must NOT trigger
      const result = rewriteWithConstSubstitutions(yDecl.initializer, new Map(), checker, imports);

      expect(ts.isPropertyAccessExpression(result)).toBe(true);
      const propAccess = result as ts.PropertyAccessExpression;
      expect(ts.isCallExpression(propAccess.expression)).toBe(true);
      const call = propAccess.expression as ts.CallExpression;
      expect((call.arguments[0] as ts.StringLiteral).text).toBe("mymod");
      expect(propAccess.name.text).toBe("fn");
    });
  });
});
