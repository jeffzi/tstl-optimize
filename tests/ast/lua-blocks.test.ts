// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { forEachNestedStatementList } from "../../src/ast/lua-blocks";

describe("forEachNestedStatementList", () => {
  const createStmtExpr = (name: string) =>
    tstl.createExpressionStatement(tstl.createIdentifier(name));
  const createBlockWithStmt = (name: string) => tstl.createBlock([createStmtExpr(name)]);

  describe("compound statement types", () => {
    it.each([
      {
        name: "DoStatement",
        stmt: () => tstl.createDoStatement([createStmtExpr("a"), createStmtExpr("b")]),
        expectedListCount: 1,
      },
      {
        name: "IfStatement without else",
        stmt: () =>
          tstl.createIfStatement(tstl.createBooleanLiteral(true), createBlockWithStmt("x")),
        expectedListCount: 1,
      },
      {
        name: "IfStatement with Block else",
        stmt: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            createBlockWithStmt("x"),
            createBlockWithStmt("y"),
          ),
        expectedListCount: 2,
      },
      {
        name: "WhileStatement",
        stmt: () =>
          tstl.createWhileStatement(createBlockWithStmt("z"), tstl.createBooleanLiteral(true)),
        expectedListCount: 1,
      },
      {
        name: "RepeatStatement",
        stmt: () =>
          tstl.createRepeatStatement(createBlockWithStmt("a"), tstl.createBooleanLiteral(false)),
        expectedListCount: 1,
      },
      {
        name: "ForStatement",
        stmt: () =>
          tstl.createForStatement(
            createBlockWithStmt("i"),
            tstl.createIdentifier("i"),
            tstl.createNumericLiteral(1),
            tstl.createNumericLiteral(10),
          ),
        expectedListCount: 1,
      },
      {
        name: "ForInStatement",
        stmt: () =>
          tstl.createForInStatement(
            createBlockWithStmt("v"),
            [tstl.createIdentifier("v")],
            [tstl.createIdentifier("array")],
          ),
        expectedListCount: 1,
      },
    ])("yields statement list(s) for $name", ({ stmt, expectedListCount }) => {
      const statement = stmt();
      let visitCount = 0;

      forEachNestedStatementList(statement, () => {
        visitCount++;
        return undefined;
      });

      expect(visitCount).toBe(expectedListCount);
    });

    it("does not call visitor for non-compound statement (ExpressionStatement)", () => {
      const stmt = tstl.createExpressionStatement(tstl.createIdentifier("x"));
      let visitCount = 0;

      forEachNestedStatementList(stmt, () => {
        visitCount++;
        return undefined;
      });

      expect(visitCount).toBe(0);
    });
  });

  describe("DoStatement", () => {
    it("yields the direct statements array (same object reference)", () => {
      const statements = [
        tstl.createExpressionStatement(tstl.createIdentifier("a")),
        tstl.createExpressionStatement(tstl.createIdentifier("b")),
      ];
      const doStmt = tstl.createDoStatement(statements);

      let capturedStatements: readonly tstl.Statement[] | undefined;
      forEachNestedStatementList(doStmt, (stmts) => {
        capturedStatements = stmts;
        return undefined;
      });

      expect(capturedStatements).toBeDefined();
      expect(capturedStatements).toBe(doStmt.statements);
      expect(capturedStatements).toStrictEqual(statements);
    });
  });

  describe("IfStatement", () => {
    it("yields only ifBlock.statements when no else", () => {
      const ifBlockStmts = [tstl.createExpressionStatement(tstl.createIdentifier("x"))];
      const ifStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true),
        tstl.createBlock(ifBlockStmts),
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(ifStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return undefined;
      });

      expect(visitedLists).toHaveLength(1);
      expect(visitedLists[0]).toStrictEqual(ifBlockStmts);
    });

    it("yields ifBlock.statements then else block statements for Block else", () => {
      const ifBlockStmts = [tstl.createExpressionStatement(tstl.createIdentifier("x"))];
      const elseBlockStmts = [tstl.createExpressionStatement(tstl.createIdentifier("y"))];
      const ifStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true),
        tstl.createBlock(ifBlockStmts),
        tstl.createBlock(elseBlockStmts),
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(ifStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return undefined;
      });

      expect(visitedLists).toHaveLength(2);
      expect(visitedLists[0]).toStrictEqual(ifBlockStmts);
      expect(visitedLists[1]).toStrictEqual(elseBlockStmts);
    });

    it("recursively yields through else-if chain", () => {
      // if A then S1 else if B then S2 end end
      const s1 = tstl.createExpressionStatement(tstl.createIdentifier("s1"));
      const s2 = tstl.createExpressionStatement(tstl.createIdentifier("s2"));

      const innerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(false), // B
        tstl.createBlock([s2]),
      );

      const outerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true), // A
        tstl.createBlock([s1]),
        innerIfStmt,
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(outerIfStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return undefined;
      });

      expect(visitedLists).toHaveLength(2);
      expect(visitedLists[0][0]).toBe(s1);
      expect(visitedLists[1][0]).toBe(s2);
    });

    it("yields both branches of else-if chain with inner else block", () => {
      // if A then S1 else if B then S2 else S3 end end
      const s1 = tstl.createExpressionStatement(tstl.createIdentifier("s1"));
      const s2 = tstl.createExpressionStatement(tstl.createIdentifier("s2"));
      const s3 = tstl.createExpressionStatement(tstl.createIdentifier("s3"));

      const innerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(false), // B
        tstl.createBlock([s2]),
        tstl.createBlock([s3]),
      );

      const outerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true), // A
        tstl.createBlock([s1]),
        innerIfStmt,
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(outerIfStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return undefined;
      });

      expect(visitedLists).toHaveLength(3);
      expect(visitedLists[0][0]).toBe(s1);
      expect(visitedLists[1][0]).toBe(s2);
      expect(visitedLists[2][0]).toBe(s3);
    });
  });

  describe("early exit via visitor return true", () => {
    it("stops iteration after first visitor return true", () => {
      const ifBlockStmts = [tstl.createExpressionStatement(tstl.createIdentifier("x"))];
      const elseBlockStmts = [tstl.createExpressionStatement(tstl.createIdentifier("y"))];
      const ifStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true),
        tstl.createBlock(ifBlockStmts),
        tstl.createBlock(elseBlockStmts),
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(ifStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return true; // stop after first
      });

      expect(visitedLists).toHaveLength(1);
      expect(visitedLists[0]).toStrictEqual(ifBlockStmts);
    });

    it.each([
      {
        name: "DoStatement",
        stmt: () => tstl.createDoStatement([createStmtExpr("a")]),
      },
      {
        name: "WhileStatement",
        stmt: () =>
          tstl.createWhileStatement(createBlockWithStmt("a"), tstl.createBooleanLiteral(true)),
      },
      {
        name: "RepeatStatement",
        stmt: () =>
          tstl.createRepeatStatement(createBlockWithStmt("a"), tstl.createBooleanLiteral(true)),
      },
      {
        name: "ForStatement",
        stmt: () =>
          tstl.createForStatement(
            createBlockWithStmt("a"),
            tstl.createIdentifier("i"),
            tstl.createNumericLiteral(1),
            tstl.createNumericLiteral(10),
          ),
      },
      {
        name: "ForInStatement",
        stmt: () =>
          tstl.createForInStatement(
            createBlockWithStmt("a"),
            [tstl.createIdentifier("v")],
            [tstl.createIdentifier("t")],
          ),
      },
      {
        name: "IfStatement Block else",
        stmt: () =>
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            createBlockWithStmt("a"),
            createBlockWithStmt("b"),
          ),
      },
    ])("stops iteration on visitor return true for $name", ({ stmt }) => {
      let count = 0;

      forEachNestedStatementList(stmt(), () => {
        count++;
        return true;
      });

      expect(count).toBe(1);
    });

    it("stops recursion through else-if chain when visitor returns true", () => {
      // if A then S1 else if B then S2 end end
      const s1 = tstl.createExpressionStatement(tstl.createIdentifier("s1"));
      const s2 = tstl.createExpressionStatement(tstl.createIdentifier("s2"));

      const innerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(false),
        tstl.createBlock([s2]),
      );

      const outerIfStmt = tstl.createIfStatement(
        tstl.createBooleanLiteral(true),
        tstl.createBlock([s1]),
        innerIfStmt,
      );

      const visitedLists: tstl.Statement[][] = [];
      forEachNestedStatementList(outerIfStmt, (stmts) => {
        visitedLists.push([...stmts]);
        return true; // stop after first
      });

      expect(visitedLists).toHaveLength(1);
      expect(visitedLists[0][0]).toBe(s1);
    });
  });
});
