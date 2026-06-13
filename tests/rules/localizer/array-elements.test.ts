// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { replaceArrayElements } from "../../../src/rules/localizer/array-elements";

function id(name: string): tstl.Identifier {
  return tstl.createIdentifier(name);
}

function arrIndex(base: string, idx: string): tstl.TableIndexExpression {
  return tstl.createTableIndexExpression(id(base), id(idx));
}

describe("replaceArrayElements", () => {
  describe("expr hook — base not in hoisted map", () => {
    it("leaves base[loopVar] expression unchanged when base is absent from the hoisted map", () => {
      const access = arrIndex("arr", "i");
      const stmt = tstl.createExpressionStatement(access);
      const statements: tstl.Statement[] = [stmt];

      // "arr" is NOT in the hoisted map — covers the false branch of `if (ident)`
      replaceArrayElements(statements, new Map(), new Set(["i"]));

      expect(tstl.isTableIndexExpression(stmt.expression)).toBe(true);
    });
  });

  describe("stmt hook — ForStatement with non-matching control variable", () => {
    it("replaces arr[i] inside body when ForStatement control variable is not a loop variable", () => {
      // ForStatement with control "j" — not in loopVarNames {"i"}.
      // The stmt handler must not call control.skip(), so the walker recurses into the body
      // and replaces arr[i] with ____arr.
      const innerStmt = tstl.createExpressionStatement(arrIndex("arr", "i"));
      const forStmt = tstl.createForStatement(
        tstl.createBlock([innerStmt]),
        id("j"),
        tstl.createNumericLiteral(1),
        tstl.createNumericLiteral(10),
      );

      const hoisted = new Map([["arr", id("____arr")]]);
      replaceArrayElements([forStmt], hoisted, new Set(["i"]));

      // Walker recursed into the body and replaced arr[i] with the hoisted identifier
      expect(tstl.isIdentifier(innerStmt.expression)).toBe(true);
      if (tstl.isIdentifier(innerStmt.expression)) {
        expect(innerStmt.expression.text).toBe("____arr");
      }
    });
  });

  describe("stmt hook — ForInStatement with matching name", () => {
    it("does not replace arr[i] inside body when ForInStatement names include the loop variable", () => {
      const innerStmt = tstl.createExpressionStatement(arrIndex("arr", "i"));
      const forInStmt = tstl.createForInStatement(
        tstl.createBlock([innerStmt]),
        [id("i")],
        [tstl.createNilLiteral()],
      );

      const hoisted = new Map([["arr", id("____arr")]]);
      replaceArrayElements([forInStmt], hoisted, new Set(["i"]));

      // Walker skips the body — arr[i] must not be replaced
      expect(tstl.isTableIndexExpression(innerStmt.expression)).toBe(true);
    });
  });

  describe("stmt hook — assignment LHS not in hoisted map", () => {
    it("leaves assignment LHS unchanged when base is absent from the hoisted map", () => {
      // arr[i] = 5, but "arr" is NOT in hoisted — covers the false branch of `if (ident)` on LHS
      const lhs = arrIndex("arr", "i");
      const assignStmt = tstl.createAssignmentStatement(lhs, tstl.createNumericLiteral(5));
      const statements: tstl.Statement[] = [assignStmt];

      replaceArrayElements(statements, new Map(), new Set(["i"]));

      // LHS is still a table index expression (not replaced)
      expect(tstl.isTableIndexExpression(assignStmt.left[0])).toBe(true);
    });
  });
});
