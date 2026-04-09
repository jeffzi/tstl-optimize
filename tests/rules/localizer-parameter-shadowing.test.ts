// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("localizer: parameter shadowing", () => {
  it("hoists outer scope property chain when nested function shadows the chain root with parameter", () => {
    const lua = compile(
      `
      declare const config: { timeout: number };
      function outer() {
        const a = config.timeout;
        const b = config.timeout;
        const c = config.timeout;

        function inner(config: string) {
          return config.length;
        }

        return inner("test");
      }
      `,
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "function" as const,
              include: ["config"],
            },
          },
        },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );

    // The outer scope's config.timeout should be hoisted to a local variable
    // even though the nested function has a parameter named 'config'
    expect(lua).toContain("local ____config_timeout = config.timeout");
    // The hoisted variable should be used in place of the property chain
    expect(lua).toContain("____config_timeout");
    // The nested function should still exist in output
    expect(lua).toContain("local function inner");
  });
});
