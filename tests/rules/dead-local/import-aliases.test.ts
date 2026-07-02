// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { eliminateDeadImportAliases } from "../../../src/rules/dead-local/import-aliases";
import { compile, compileMultiFileWithDiagnostics, normalizeLua } from "../../helpers";

describe("dead-local — import alias elimination", () => {
  describe("when all aliases are dead", () => {
    it("removes all aliases and the require", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          /** @inline */
          export function double(x: number): number {
            return x * 2;
          }
        `,
        "main.ts": `
          import { double } from "./helper";
          const result = double(21);
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).not.toContain("____helper");
      expect(normalized).not.toContain('require("helper")');
      expect(normalized).not.toContain("local double");
      // Inlined body may be constant-folded or kept as-is
      const hasInlinedBody = normalized.includes("21 * 2") || normalized.includes("42");
      expect(hasInlinedBody, '"21 * 2" or "42" not found in output').toBe(true);
    });

    it("removes alias for re-exported inlined function", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          /** @inline */
          export function triple(x: number): number {
            return x * 3;
          }
        `,
        "main.ts": `
          import { triple } from "./helper";
          export const exported = triple(10);
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).not.toContain("local triple");
      expect(normalized).not.toContain("____helper.triple");
      expect(normalized).not.toContain("____helper");
      expect(normalized).not.toContain('require("helper")');
      // Inlined body may be constant-folded or kept as-is
      const hasInlinedBody = normalized.includes("10 * 3") || normalized.includes("30");
      expect(hasInlinedBody, '"10 * 3" or "30" not found in output').toBe(true);
    });
  });

  describe("when some aliases are live", () => {
    it("removes dead alias but keeps live alias and require", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          /** @inline */
          export function is_zero(x: number): boolean {
            return x === 0;
          }

          export function format(x: number): string {
            return x.toString();
          }
        `,
        "main.ts": `
          import { is_zero, format } from "./helper";
          const result = is_zero(5);
          const text = format(42);
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).not.toContain("local is_zero");
      expect(normalized).toContain("local format");
      expect(normalized).toContain("____helper.format");
      expect(normalized).toContain("____helper");
      expect(normalized).toContain('require("helper")');
    });

    it("preserves alias and require for non-inlined import", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          export const config = { value: 42 };

          export function getValue(): number {
            return config.value;
          }
        `,
        "main.ts": `
          import { getValue } from "./helper";
          const result = getValue();
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("local getValue");
      expect(normalized).toContain("____helper");
      expect(normalized).toContain("getValue()");
    });

    it("preserves alias used in closure capture", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          export function process(x: number): number {
            return x * 2;
          }
        `,
        "main.ts": `
          import { process } from "./helper";
          const fn = () => process(5);
          export const result = fn();
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("local process");
      expect(normalized).toContain("____helper.process");
    });
  });

  describe("when no imports are present", () => {
    it("does not modify module-scope locals", () => {
      const lua = compile("const x = 1;", {
        pluginOptions: { rules: { "constant-propagation": false } },
      });
      expect(lua).toContain("x = 1");
    });

    it("does not modify function-scope locals", () => {
      const lua = compile(
        `
        function f() {
          const x = 1;
          return x;
        }
      `,
        { pluginOptions: { rules: { "constant-propagation": false } } },
      );
      expect(lua).toContain("x = 1");
      expect(lua).toContain("return x");
    });
  });

  describe("edge cases", () => {
    it("handles multiple require bindings independently", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "lib1.ts": `
          /** @inline */
          export function a(): number { return 1; }
        `,
        "lib2.ts": `
          export function b(): number { return 2; }
        `,
        "main.ts": `
          import { a } from "./lib1";
          import { b } from "./lib2";
          const x = a();
          const y = b();
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).not.toContain("____lib1");
      expect(normalized).toContain("____lib2");
      expect(normalized).toContain("____lib2.b");
    });

    it("ignores non-require table access", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "helper.ts": `
          /** @inline */
          export function noop(): void {}
        `,
        "main.ts": `
          import { noop } from "./helper";
          declare const globalObj: { prop: number };
          noop();
          export const val = globalObj.prop;
        `,
      });
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("globalObj.prop");
    });

    it("preserves plugin-emitted identifiers without symbolId", () => {
      // Plugin-emitted identifiers lack symbolId (created outside normal TSTL transpilation),
      // so they're not tracked in read sets. Without conservative handling, they're removed.
      const requireId = tstl.createIdentifier("____gen");
      requireId.symbolId = undefined;

      const requireStmt = tstl.createVariableDeclarationStatement(
        [requireId],
        [
          tstl.createCallExpression(tstl.createIdentifier("require"), [
            tstl.createStringLiteral("src.generated"),
          ]),
        ],
      );

      const aliveId = tstl.createIdentifier("____alive");
      aliveId.symbolId = undefined;

      const aliveStmt = tstl.createVariableDeclarationStatement(
        [aliveId],
        [tstl.createTableIndexExpression(requireId, tstl.createStringLiteral("alive"))],
      );

      const spawnId = tstl.createIdentifier("____spawn__");
      spawnId.symbolId = undefined;

      const spawnStmt = tstl.createVariableDeclarationStatement(
        [spawnId],
        [tstl.createTableIndexExpression(requireId, tstl.createStringLiteral("spawn__"))],
      );

      const useAliveStmt = tstl.createExpressionStatement(aliveId);
      const useSpawnStmt = tstl.createExpressionStatement(tstl.createCallExpression(spawnId, []));

      const statements: tstl.Statement[] = [
        requireStmt,
        aliveStmt,
        spawnStmt,
        useAliveStmt,
        useSpawnStmt,
      ];

      eliminateDeadImportAliases(statements);

      expect(statements.length).toBe(5);
      expect(statements).toContain(requireStmt);
      expect(statements).toContain(aliveStmt);
      expect(statements).toContain(spawnStmt);
    });

    it("matches aliases by table identifier text when object identity differs", () => {
      // Plugin-emitted code may create separate Identifier objects for the same variable name.
      // Before the fix: matchImportAlias used object-identity lookup, so when an alias's table
      // used a different Identifier object with the same text, the lookup would fail.
      //
      // This test creates a require binding and an alias that uses a separate Identifier
      // object with the same text. The alias is treated conservatively (symbolId = undefined),
      // so both the alias and require should be preserved.
      const requireIdInBinding = tstl.createIdentifier("____gen");
      requireIdInBinding.symbolId = undefined;

      const requireStmt = tstl.createVariableDeclarationStatement(
        [requireIdInBinding],
        [
          tstl.createCallExpression(tstl.createIdentifier("require"), [
            tstl.createStringLiteral("src.generated"),
          ]),
        ],
      );

      // DIFFERENT Identifier object for the alias (same text, different object)
      const requireIdForAlias = tstl.createIdentifier("____gen");
      requireIdForAlias.symbolId = undefined;

      const aliasId = tstl.createIdentifier("____alive");
      aliasId.symbolId = undefined;

      const aliasStmt = tstl.createVariableDeclarationStatement(
        [aliasId],
        [tstl.createTableIndexExpression(requireIdForAlias, tstl.createStringLiteral("value"))],
      );

      const statements: tstl.Statement[] = [requireStmt, aliasStmt];

      eliminateDeadImportAliases(statements);

      // Both statements should be preserved:
      // - The alias has symbolId = undefined, so it's treated conservatively as potentially alive
      // - The require should be kept because the alias references it
      expect(statements.length).toBe(2);
      expect(statements).toContain(requireStmt);
      expect(statements).toContain(aliasStmt);
    });

    it("preserves alias with defined symbolId when read via undefined symbolId identifier", () => {
      // When an alias has a defined symbolId (properly tracked by TSTL) but is read through an
      // identifier with symbolId === undefined (JSX-transpiled code), the alias should be preserved.
      // This tests the scenario where the alias declaration has symbolId but is read by code
      // that lacks symbolId.
      const requireId = tstl.createIdentifier("____React");
      requireId.symbolId = 100 as tstl.SymbolId; // Proper TSTL-assigned symbolId

      const requireStmt = tstl.createVariableDeclarationStatement(
        [requireId],
        [
          tstl.createCallExpression(tstl.createIdentifier("require"), [
            tstl.createStringLiteral("react"),
          ]),
        ],
      );

      // Alias: local React = ____React.default
      const ReactId = tstl.createIdentifier("React");
      ReactId.symbolId = 200 as tstl.SymbolId; // Proper TSTL-assigned symbolId

      const ReactStmt = tstl.createVariableDeclarationStatement(
        [ReactId],
        [tstl.createTableIndexExpression(requireId, tstl.createStringLiteral("default"))],
      );

      // Usage: React.createElement(...) but the identifier has symbolId = undefined
      // (This simulates JSX transpilation creating code outside normal TSTL tracking)
      const ReactUsageId = tstl.createIdentifier("React");
      ReactUsageId.symbolId = undefined; // JSX-generated code has no symbolId

      const useReactStmt = tstl.createExpressionStatement(
        tstl.createCallExpression(
          tstl.createTableIndexExpression(ReactUsageId, tstl.createStringLiteral("createElement")),
          [],
        ),
      );

      const statements: tstl.Statement[] = [requireStmt, ReactStmt, useReactStmt];

      eliminateDeadImportAliases(statements);

      // Both the require and the alias should be preserved because an undefined-symbolId
      // identifier with the name "React" exists in a read position.
      expect(statements.length).toBe(3);
      expect(statements).toContain(requireStmt);
      expect(statements).toContain(ReactStmt);
      expect(statements).toContain(useReactStmt);
    });

    it("preserves require binding with no aliases read only by an undefined-symbolId identifier", () => {
      // A require binding with NO import aliases, read only by a symbolId-less identifier,
      // should be preserved. The test constructs a live-alias scaffolding to bypass the early
      // return (importAliases.length === 0), then adds the subject binding with a direct read.

      // First require: local ____live = require("live")
      const liveId = tstl.createIdentifier("____live");
      liveId.symbolId = 100 as tstl.SymbolId; // Real TSTL-assigned symbolId

      const liveRequireStmt = tstl.createVariableDeclarationStatement(
        [liveId],
        [
          tstl.createCallExpression(tstl.createIdentifier("require"), [
            tstl.createStringLiteral("live"),
          ]),
        ],
      );

      // Alias for live: local aliasName = ____live.member
      const aliasId = tstl.createIdentifier("aliasName");
      aliasId.symbolId = 200 as tstl.SymbolId; // Real TSTL-assigned symbolId

      const liveAliasStmt = tstl.createVariableDeclarationStatement(
        [aliasId],
        [tstl.createTableIndexExpression(liveId, tstl.createStringLiteral("member"))],
      );

      // Read of the alias: aliasName
      const aliasReadId = tstl.createIdentifier("aliasName");
      aliasReadId.symbolId = 200 as tstl.SymbolId;
      const aliasReadStmt = tstl.createExpressionStatement(aliasReadId);

      // Second require: local ____mod2 = require("mod2")
      const mod2Id = tstl.createIdentifier("____mod2");
      mod2Id.symbolId = undefined; // Plugin-emitted (no symbolId)

      const mod2RequireStmt = tstl.createVariableDeclarationStatement(
        [mod2Id],
        [
          tstl.createCallExpression(tstl.createIdentifier("require"), [
            tstl.createStringLiteral("mod2"),
          ]),
        ],
      );

      // Direct read of mod2 via symbolId-less identifier: ____mod2.foo()
      const mod2ReadId = tstl.createIdentifier("____mod2");
      mod2ReadId.symbolId = undefined; // Plugin-emitted (no symbolId)

      const mod2ReadStmt = tstl.createExpressionStatement(
        tstl.createCallExpression(
          tstl.createTableIndexExpression(mod2ReadId, tstl.createStringLiteral("foo")),
          [],
        ),
      );

      const statements: tstl.Statement[] = [
        liveRequireStmt,
        liveAliasStmt,
        aliasReadStmt,
        mod2RequireStmt,
        mod2ReadStmt,
      ];

      eliminateDeadImportAliases(statements);

      // Assert: mod2RequireStmt (binding with no aliases, read only by undefined-symbolId)
      // should be preserved
      expect(statements).toContain(mod2RequireStmt);
      // Assert: scaffolding (live require and alias) also survives
      expect(statements).toContain(liveRequireStmt);
      expect(statements).toContain(liveAliasStmt);
      expect(statements).toContain(aliasReadStmt);
      expect(statements).toContain(mod2ReadStmt);
      // Assert: final length (all 5 statements preserved)
      expect(statements.length).toBe(5);
    });
  });
});
