import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/remove-empty-branch";
import { compile, EMPTY_SOURCE_FILE, normalizeLua } from "../helpers";

const opts = {
  pluginOptions: {
    rules: {
      "constant-propagation": false,
      "constant-folding": false,
      "dead-local": false,
      "remove-empty-branch": true,
    },
  },
};

function expectCompiledLua(source: string, expected: string, options = opts): void {
  const lines = expected.split("\n");
  const contentLines = lines.filter((line) => line.trim().length > 0);
  const minIndent = contentLines.reduce<number>((smallestIndent, line) => {
    const indent = line.length - line.trimStart().length;
    return Math.min(smallestIndent, indent);
  }, Number.POSITIVE_INFINITY);
  const normalizedExpected = contentLines.map((line) => line.slice(minIndent)).join("\n");

  expect(normalizeLua(compile(source, options))).toBe(normalizedExpected);
}

describe("remove-empty-branch rule", () => {
  describe("basic rule behavior", () => {
    it("does not remove empty if statements when rule is disabled", () => {
      const source = `
        const x = false;
        if (x) {}
      `;
      // Disable the rule under test to verify it was the one removing statements
      expect(
        normalizeLua(
          compile(source, {
            pluginOptions: {
              rules: { ...opts.pluginOptions.rules, "remove-empty-branch": false },
            },
          }),
        ),
      ).toMatchInlineSnapshot(`
        "x = false
        if x then
        end"
      `);
    });
  });

  describe("remove entirely-empty if-chains", () => {
    it.each([
      {
        name: "removes an empty if statement with a function-local identifier condition",
        source: `
          function test() {
            const x = true;
            if (x) {}
          }
        `,
        expected: `
          function test()
          local x = true
          end
        `,
      },
      {
        name: "removes an empty if statement with a literal condition",
        source: `
          if (true) {}
        `,
        expected: "",
      },
      {
        name: "removes an entirely empty if-elseif-else chain with local identifiers",
        source: `
          function test() {
            const x = true;
            const y = false;
            if (x) {} else if (y) {} else {}
          }
        `,
        expected: `
          function test()
          local x, y = true, false
          end
        `,
      },
      {
        name: "removes an empty if statement with a negated local condition",
        source: `
          function test() {
            const x = true;
            if (!x) {}
          }
        `,
        expected: `
          function test()
          local x = true
          end
        `,
      },
    ])("$name", ({ source, expected }) => {
      expectCompiledLua(source, expected);
    });

    it("preserves if statements with impure conditions or non-empty branches", () => {
      const source = `
        const x = true;
        function sideEffect(): boolean { return true; }
        if (sideEffect()) {}
        if (x) {} else if (sideEffect()) {}
        if (x) { const y = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "x = true
        function sideEffect()
        return true
        end
        if sideEffect() then
        end
        if x then
        elseif sideEffect() then
        end
        if x then
        local y = 1
        end"
      `);
    });

    it("preserves empty if statements with compound conditions", () => {
      const source = `
        const x = true;
        const y = false;
        if (x && y) {}
      `;

      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "x = true
        y = false
        if x and y then
        end"
      `);
    });

    it("preserves empty if statements whose condition reads a declared global", () => {
      const source = `
        declare const SHOULD_STAY: boolean;
        if (SHOULD_STAY) {}
      `;

      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "if SHOULD_STAY then
        end"
      `);
    });

    it("handles nested empty if statements", () => {
      const source = `
        function test() {
          const x = true;
          if (x) {}
        }
        const outer = true;
        if (outer) {
          const inner = true;
          const z = 1;
          if (inner) {}
        }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "function test()
        local x = true
        end
        outer = true
        if outer then
        local inner, z = true, 1
        end"
      `);
    });
  });

  describe("prune trailing empty elseif/else branches", () => {
    it.each([
      {
        name: "removes a trailing empty elseif block with a pure condition",
        source: `
          const x = true;
          if (x) { const z = 1; } else if (false) {}
        `,
        expected: `
          x = true
          if x then
          local z = 1
          end
        `,
      },
      {
        name: "removes trailing empty elseif and else blocks with pure conditions",
        source: `
          const x = true;
          if (x) { const z = 1; } else if (false) {} else {}
        `,
        expected: `
          x = true
          if x then
          local z = 1
          end
        `,
      },
      {
        name: "removes a trailing empty else block",
        source: `
          const x = true;
          if (x) { const z = 1; } else {}
        `,
        expected: `
          x = true
          if x then
          local z = 1
          end
        `,
      },
    ])("$name", ({ source, expected }) => {
      expectCompiledLua(source, expected);
    });

    it("preserves trailing elseif with impure conditions", () => {
      const source = `
        const x = true;
        function sideEffect(): boolean { return false; }
        if (x) { const z = 1; } else if (sideEffect()) {}
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "x = true
        function sideEffect()
        return false
        end
        if x then
        local z = 1
        elseif sideEffect() then
        end"
      `);
    });

    it("handles complex chains with interleaved empty and non-empty branches", () => {
      const source = `
        const a = true;
        const b = false;
        if (a) { const x = 1; }
        else if (b) { const y = 2; }
        else if (false) {}
        else {}
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "a = true
        b = false
        if a then
        local x = 1
        elseif b then
        local y = 2
        end"
      `);
    });
  });

  describe("promote else block when if-block is empty", () => {
    it("pure condition + plain else: negates condition and promotes else", () => {
      const source = `
        const x = true;
        if (x) {} else { const z = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "x = true
        if not x then
        local z = 1
        end"
      `);
    });

    it("negates impure condition and promotes else to if-body", () => {
      const source = `
        function sideEffect(): boolean { return false; }
        if (sideEffect()) {} else { const z = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "function sideEffect()
        return false
        end
        if not sideEffect() then
        local z = 1
        end"
      `);
    });

    it("wraps compound conditions when promoting else to preserve Lua precedence", () => {
      const source = `
        declare const a: boolean;
        declare const b: boolean;
        if (a && b) {} else { const z = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "if not (a and b) then
        local z = 1
        end"
      `);
    });

    it("pure condition + elseif chain: leaves elseif chain untouched", () => {
      const source = `
        const x = true;
        if (x) {} else if (false) { const z = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "x = true
        if x then
        elseif false then
        local z = 1
        end"
      `);
    });

    it("preserves impure leading if with empty body and elseif chain", () => {
      const source = `
        function sideEffect(): boolean { return false; }
        if (sideEffect()) {} else if (false) { const z = 1; }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "function sideEffect()
        return false
        end
        if sideEffect() then
        elseif false then
        local z = 1
        end"
      `);
    });

    it("empty else guard: if (impure()) {} else {} → unchanged", () => {
      const source = `
        function sideEffect(): boolean { return false; }
        if (sideEffect()) {} else {}
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "function sideEffect()
        return false
        end
        if sideEffect() then
        end"
      `);
    });
  });

  describe("remove empty branches inside loop bodies", () => {
    it.each([
      {
        name: "removes an empty if statement inside a while loop with local conditions",
        source: `
          function test() {
            const x = true;
            while (x) {
              if (x) {}
              const z = 1;
            }
          }
        `,
        expected: `
          function test()
          local x = true
          while x do
          local z = 1
          end
          end
        `,
      },
      {
        name: "removes an empty if statement inside a counted while loop with local conditions",
        source: `
          function test() {
            const x = true;
            let i = 0;
            while (i < 3) {
              if (x) {}
              i++;
            }
          }
        `,
        expected: `
          function test()
          local x, i = true, 0
          while i < 3 do
          i = i + 1
          end
          end
        `,
      },
    ])("$name", ({ source, expected }) => {
      expectCompiledLua(source, expected);
    });
  });

  describe("remove empty do-end blocks", () => {
    it("removes empty do blocks from inlined functions with pruned branches", () => {
      const source = `
        /** @inline */
        function withEmptyBranches(): void {
          if (true) {} else if (false) {}
        }
        withEmptyBranches();
        const result = 1;
      `;
      expectCompiledLua(source, "result = 1");
    });

    it("preserves non-empty do blocks from inlined functions", () => {
      const source = `
        /** @inline */
        function withBody(): void {
          const a = 1;
        }
        withBody();
        const x = 1;
      `;
      expectCompiledLua(
        source,
        `
          do
          local a = 1
          end
          x = 1
        `,
      );
    });

    it("removes multiple and nested empty do blocks", () => {
      const source = `
        /** @inline */
        function noop1(): void { if (true) {} }
        /** @inline */
        function noop2(): void { if (false) {} else {} }

        noop1();
        if (true) {
          noop2();
        }
        const z = 3;
      `;
      expectCompiledLua(source, "z = 3");
    });
  });

  describe("interaction with conditional-compilation", () => {
    it("removes an if-block whose inner body was emptied by conditional-compilation", () => {
      // CC strips if(PROD){z=1} entirely (PROD=false, no else → returns undefined).
      // The outer if(x) body becomes empty; remove-empty-branch then prunes the outer if.
      const source = `
        /** @define PROD */
        declare const PROD: boolean;
        function test() {
          const x = true;
          if (x) {
            if (PROD) { const z = 1; }
          }
          const y = 2;
        }
      `;

      expect(
        normalizeLua(
          compile(source, {
            pluginOptions: {
              rules: {
                "constant-propagation": false,
                "conditional-compilation": {
                  constants: { PROD: { env: "__TSTL_TEST_UNUSED_VAR__", default: false } },
                },
                "remove-empty-branch": true,
                "constant-folding": false,
                "dead-local": false,
              },
            },
          }),
        ),
      ).toBe("function test()\nlocal x, y = true, 2\nend");
    });
  });

  describe("parenthesized conditions in if-statements", () => {
    it("removes an empty if-statement whose condition is a double-parenthesized local", () => {
      // Exercises the isSafeEmptyBranchCondition parenthesized-expression path.
      // TypeScript double-parens `if ((x)) {}` produce a ParenthesizedExpression in Lua AST.
      const source = `
        function test() {
          const x = true;
          if ((x)) {}
        }
      `;
      expectCompiledLua(
        source,
        `
          function test()
          local x = true
          end
        `,
      );
    });

    it("preserves an empty if-statement whose condition is a double-parenthesized global", () => {
      // A parenthesized identifier without a symbolId is a global — must not be removed.
      const source = `
        declare const GLOBAL: boolean;
        if ((GLOBAL)) {}
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "if GLOBAL then
        end"
      `);
    });
  });

  describe("direct source-file visitor coverage", () => {
    it("throws when the source-file transform does not produce a file", () => {
      // This defensive path (superTransformNode returning a non-File) cannot be
      // triggered through compile() because TSTL always returns a File for SourceFile.
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile).transform;
      if (!visitor || typeof visitor !== "function") {
        throw new Error("Expected SourceFile visitor to exist");
      }
      const nonFile = tstl.createBooleanLiteral(true);

      expect(() =>
        Reflect.apply(visitor, undefined, [
          EMPTY_SOURCE_FILE,
          { superTransformNode: () => nonFile } as unknown as tstl.TransformationContext,
        ]),
      ).toThrow();
    });
  });
});
