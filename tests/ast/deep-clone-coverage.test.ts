// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { deepCloneExpression, deepCloneStatement } from "../../src/ast/deep-clone";

function id(text: string): tstl.Identifier {
  return tstl.createIdentifier(text);
}

describe("deep-clone coverage", () => {
  it("clones MethodCallExpression", () => {
    const expr = tstl.createMethodCallExpression(id("obj"), id("method"), [id("arg")]);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones TableExpression with and without keys", () => {
    const field1 = tstl.createTableFieldExpression(id("v1"), id("k1"));
    const field2 = tstl.createTableFieldExpression(id("v2")); // No key
    const expr = tstl.createTableExpression([field1, field2]);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones FunctionExpression with dots", () => {
    const body = tstl.createBlock([]);
    const dots = tstl.createDotsLiteral();
    const expr = tstl.createFunctionExpression(body, [], dots);
    const cloned = deepCloneExpression(expr);
    expect(cloned).not.toBe(expr);
    expect(cloned).toStrictEqual(expr);
  });

  it("clones RepeatStatement", () => {
    const stmt = tstl.createRepeatStatement(tstl.createBlock([]), tstl.createBooleanLiteral(true));
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it("clones LabelStatement", () => {
    const stmt = tstl.createLabelStatement("lbl");
    const cloned = deepCloneStatement(stmt);
    expect(cloned).not.toBe(stmt);
    expect(cloned).toStrictEqual(stmt);
  });

  it("clones IfStatement with and without elseif/else", () => {
    const elseif = tstl.createIfStatement(id("c2"), tstl.createBlock([]), tstl.createBlock([]));
    const stmt1 = tstl.createIfStatement(id("c1"), tstl.createBlock([]), elseif);
    const cloned1 = deepCloneStatement(stmt1);
    expect(cloned1).toStrictEqual(stmt1);

    const stmt2 = tstl.createIfStatement(id("c1"), tstl.createBlock([]));
    const cloned2 = deepCloneStatement(stmt2);
    expect(cloned2).toStrictEqual(stmt2);

    const stmt3 = tstl.createIfStatement(id("c1"), tstl.createBlock([]), tstl.createBlock([]));
    const cloned3 = deepCloneStatement(stmt3);
    expect(cloned3).toStrictEqual(stmt3);
  });

  it("clones ForStatement with and without step", () => {
    const stmt1 = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"), id("s"));
    const stmt2 = tstl.createForStatement(tstl.createBlock([]), id("i"), id("a"), id("b"));
    expect(deepCloneStatement(stmt1)).toStrictEqual(stmt1);
    expect(deepCloneStatement(stmt2)).toStrictEqual(stmt2);
  });
});
