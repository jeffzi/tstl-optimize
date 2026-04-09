// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

const FUNC_SCOPE = {
  pluginOptions: { rules: { localizer: { scope: "function" as const } } },
};

describe("localizer uncovered branches", () => {
  describe("line 151: hasNestedFunctionExit in while/repeat body", () => {
    it("detects return in while loop body preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i === 5) return;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 154: hasNestedFunctionExit in for/forin body", () => {
    it("detects return in for loop body preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i === 5) return;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });

    it("detects break in for loop body preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i === 5) break;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 177: hasEarlyExit in do statement", () => {
    it("detects return in nested do block preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (true) {",
          "      do { return; } while (false);",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 181: hasNestedFunctionExit in while/repeat within hasEarlyExit", () => {
    it("detects nested while with return preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (true) {",
          "      while (true) { return; }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("accept hoisting when no early exit", () => {
    it("hoists array access with no early exit in loop", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).toContain("local ____arr");
    });
  });

  describe("line 54-70: buildRootFilter non-wildcard and wildcard paths", () => {
    it("non-wildcard: custom includes with excludes prevent hoisting", () => {
      const lua = compile(
        [
          "declare const custom1: { value: number };",
          "declare const custom2: { value: number };",
          "const a = custom1.value; const b = custom1.value;",
          "const c = custom2.value; const d = custom2.value;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["custom1", "custom2"],
                exclude: ["custom1"],
              },
            },
          },
        },
      );
      // custom1 is excluded even though included
      expect(lua).not.toContain("local ____custom1_value");
      // custom2 is included and not excluded
      expect(lua).toContain("local ____custom2_value = custom2.value");
    });

    it("non-wildcard: include blocklisted root explicitly overrides blocklist", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag; const b = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["assert"],
              },
            },
          },
        },
      );
      // Non-wildcard include of blocklisted root should hoist
      expect(lua).toContain("local ____assert_are_not_flag = assert.are_not.flag");
    });
  });

  describe("line 58: wildcard exclude path in buildRootFilter", () => {
    it("wildcard with exclude removes specific root from allowed set", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "declare const api: { base: { url: string } };",
          "const a = config.graphics.width; const b = config.graphics.width;",
          "const c = api.base.url; const d = api.base.url;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["*"],
                exclude: ["config"],
              },
            },
          },
        },
      );
      // config is excluded → should NOT be hoisted
      expect(lua).not.toContain("local ____config_graphics_width");
      expect(lua).toContain("config.graphics.width");
      // api is wildcard-included and not excluded → should be hoisted
      expect(lua).toContain("local ____api_base_url = api.base.url");
    });

    it("wildcard exclude of multiple roots", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "declare const config: { graphics: { width: number } };",
          "declare const api: { base: { url: string } };",
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "const c = config.graphics.width; const d = config.graphics.width;",
          "const e = api.base.url; const f = api.base.url;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["*"],
                exclude: ["config", "api"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Both config and api are excluded
      expect(lua).not.toContain("local ____config_graphics_width");
      expect(lua).not.toContain("local ____api_base_url");
      // Math is not excluded, should still hoist
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });
  });

  describe("line 59: blocklist check in wildcard path", () => {
    it("wildcard does not hoist blocklisted root unless explicitly included", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag; const b = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "module" as const, include: ["*"] },
            },
          },
        },
      );
      // Even with wildcard, blocklisted root (assert) should NOT be hoisted
      expect(lua).not.toContain("local ____assert_are_not_flag");
    });

    it("wildcard with explicit blocklist override hoists blocklisted root", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag; const b = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["*", "assert"],
              },
            },
          },
        },
      );
      // Explicit include of blocklisted root overrides the blocklist
      expect(lua).toContain("local ____assert_are_not_flag = assert.are_not.flag");
    });
  });

  describe("line 177: hasEarlyExit with do statements containing various exits", () => {
    it("detects return in do statement preventing array write-back", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    if (true) {",
          "      do {",
          "        return;",
          "      } while (false);",
          "    }",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });

    it("hoists when do block has no early exit", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    do {",
          "      const x = 1;",
          "    } while (false);",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).toContain("local ____arr");
    });
  });

  describe("nested control flow with early exits", () => {
    it("prevents hoisting when else-if branch has return", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    if (i > 5) {",
          "      arr[i] = arr[i] + 2;",
          "    } else if (i < 2) {",
          "      return;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 181: hasNestedFunctionExit in while/repeat from hasEarlyExit", () => {
    it("detects return in while loop within early exit check", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    if (true) {",
          "      while (true) {",
          "        return;",
          "      }",
          "    }",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });

    it("detects return in repeat loop within early exit check", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    if (true) {",
          "      do {",
          "        if (true) while (true) { return; }",
          "      } while (false);",
          "    }",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("property chain replacement in various expression contexts", () => {
    it("hoists chains used in multiple separate statements", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "const a = config.physics.gravity;",
          "const b = config.physics.gravity + 1;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "module" as const, include: ["config"] },
            },
          },
        },
      );
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
    });

    it("hoists chains used in arithmetic expressions across statements", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number }; width: number };",
          "const a1 = config.width * 2;",
          "const a2 = config.width * 3;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "module" as const, include: ["config"] },
            },
          },
        },
      );
      expect(lua).toContain("local ____config_width = config.width");
    });

    it("hoists chains in function call arguments in different statements", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "function applyGravity(g: number) { return g; }",
          "const g1 = applyGravity(config.physics.gravity);",
          "const g2 = applyGravity(config.physics.gravity);",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "module" as const, include: ["config"] },
            },
          },
        },
      );
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
    });
  });

  describe("forin loop early exit detection", () => {
    it("detects return in forin loop preventing hoisting", () => {
      const lua = compile(
        [
          "function test(obj: Record<string, number>) {",
          "  for (const key in obj) {",
          "    obj[key] = obj[key] * 2;",
          "    if (key === 'stop') return;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____obj");
    });

    it("hoists forin array access with no early exit", () => {
      const lua = compile(
        [
          "function test(obj: Record<string, number>) {",
          "  for (const key in obj) {",
          "    obj[key] = obj[key] * 2;",
          "    obj[key] = obj[key] * 3;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).toContain("local ____obj");
    });
  });

  describe("property chain hoisting with threshold and scope", () => {
    it("does not hoist chain below threshold in function scope", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "function test() {",
          "  const a = config.graphics.width;",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Single use below default threshold of 2
      expect(lua).not.toContain("local ____config_graphics_width");
    });

    it("hoists chain at threshold boundary", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "function test() {",
          "  const a = config.graphics.width;",
          "  const b = config.graphics.width;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "function" as const, include: ["config"] },
            },
          },
        },
      );
      // Exactly 2 uses (at threshold) should be hoisted
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
    });
  });

  describe("more wildcard and stdlib root combinations", () => {
    it("wildcard includes stdlib roots automatically", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "const c = Math.floor(x); const d = Math.floor(x);",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["*"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Both math functions should be hoisted with wildcard
      expect(lua).toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("local ____math_floor = math.floor");
    });

    it("non-wildcard explicit stdlib include with empty exclude", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "const c = Math.floor(x); const d = Math.floor(x);",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["math"],
                exclude: [],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Explicit include of math with empty exclude should hoist both
      expect(lua).toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("local ____math_floor = math.floor");
    });
  });

  describe("hoisting within nested scopes", () => {
    it("hoists in function body when root is not a locally defined variable", () => {
      const lua = compile(
        [
          "interface Config { graphics: { width: number } }",
          "declare const config: Config;",
          "function test() {",
          "  const a = config.graphics.width;",
          "  const b = config.graphics.width;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "function" as const, include: ["config"] },
            },
          },
        },
      );
      // config is not locally defined, so hoisting proceeds
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
    });

    it("prevents hoisting when root is locally defined (scope shadowing)", () => {
      const lua = compile(
        [
          "interface Config { graphics: { width: number } }",
          "declare const globalConfig: Config;",
          "function test() {",
          "  const config = { graphics: { width: 0 } };",
          "  const a = config.graphics.width;",
          "  const b = config.graphics.width;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "function" as const, include: ["config"] },
            },
          },
        },
      );
      // config is locally defined in function, so hoisting is prevented
      expect(lua).not.toContain("local ____config_graphics_width");
    });
  });

  describe("line 139-143: else block check - correctness of else block traversal", () => {
    it("prevents hoisting when else block has return (block statement, not if)", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i > 5) {",
          "      arr[i] = arr[i] * 2;",
          "    } else {",
          "      return;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Else block (as BlockStatement) has return → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });

    it("prevents hoisting when else-if chain has return in final else", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i > 10) {",
          "      arr[i] = arr[i] * 2;",
          "    } else if (i > 5) {",
          "      arr[i] = arr[i] * 3;",
          "    } else {",
          "      return;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Final else has return → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 154: for/forin body early exit check - prevents hoisting on break/return", () => {
    it("prevents hoisting when for loop has explicit break outside conditional", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (let i = 0; i < n; i++) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    break;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Explicit break in for loop → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });

    it("prevents hoisting when for loop body has return in nested conditional", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (let i = 0; i < n; i++) {",
          "    arr[i] = arr[i] + 1;",
          "    if (i === 5) {",
          "      break;",
          "    }",
          "    arr[i] = arr[i] + 2;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Break in conditional inside for loop → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("line 177: do statement early exit check - prevents hoisting when body has return", () => {
    it("prevents hoisting when do block has return at top level", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    do {",
          "      return;",
          "    } while (false);",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Return in do block body → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });

    it("prevents hoisting when do block has break in nested conditional", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    do {",
          "      if (i === 3) {",
          "        break;",
          "      }",
          "    } while (false);",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // Break in if inside do block → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });
  });

  describe("combined: complex control flow with multiple statements before write-back", () => {
    it("prevents hoisting when do-while with return in nested while", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    do {",
          "      while (true) {",
          "        return;",
          "      }",
          "    } while (false);",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // While with return inside do block → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });

    it("prevents hoisting when multiple if branches all have returns", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i < 5) {",
          "      return;",
          "    } else if (i < 10) {",
          "      return;",
          "    } else {",
          "      return;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // All branches have return → prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });

    it("prevents hoisting when if block has early exit but else doesn't (still prevents)", () => {
      const lua = compile(
        [
          "function test(arr: number[], n: number) {",
          "  for (const i of $range(0, n - 1)) {",
          "    arr[i] = arr[i] + 1;",
          "    arr[i] = arr[i] + 2;",
          "    if (i < 5) {",
          "      return;",
          "    } else {",
          "      arr[i] = arr[i] * 2;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // If block has return (one path exits) → still prevent hoisting
      expect(lua).not.toContain("local ____arr");
    });
  });
});
