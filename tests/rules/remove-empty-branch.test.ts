import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

const opts = {
  pluginOptions: {
    rules: {
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
        name: "removes an empty if statement with an identifier condition",
        source: `
          const x = true;
          if (x) {}
        `,
        expected: `
          x = true
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
        name: "removes an entirely empty if-elseif-else chain",
        source: `
          const x = true;
          const y = false;
          if (x) {} else if (y) {} else {}
        `,
        expected: `
          x = true
          y = false
        `,
      },
      {
        name: "removes an empty if statement with a negated pure condition",
        source: `
          const x = true;
          if (!x) {}
        `,
        expected: `
          x = true
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

    it("handles nested empty if statements", () => {
      const source = `
        function test() {
          const x = true;
          if (x) {}
        }
        const outer = true;
        const inner = true;
        if (outer) {
          const z = 1;
          if (inner) {}
        }
      `;
      expect(normalizeLua(compile(source, opts))).toMatchInlineSnapshot(`
        "function test()
        local x = true
        end
        outer = true
        inner = true
        if outer then
        local z = 1
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
        name: "removes an empty if statement inside a while loop",
        source: `
          const x = true;
          while (x) {
            if (x) {}
            const z = 1;
          }
        `,
        expected: `
          x = true
          while x do
          local z = 1
          end
        `,
      },
      {
        name: "removes an empty if statement inside a counted while loop",
        source: `
          const x = true;
          let i = 0;
          while (i < 3) {
            if (x) {}
            i++;
          }
        `,
        expected: `
          x = true
          i = 0
          while i < 3 do
          i = i + 1
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
});
