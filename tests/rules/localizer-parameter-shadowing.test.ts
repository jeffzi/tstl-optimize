// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("localizer: parameter shadowing", () => {
  it("hoists outer scope property chain when nested function shadows the chain root with parameter", () => {
    const lua = normalizeLua(
      compile(
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
                scope: "function",
                include: ["config"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      ),
    );

    // The outer scope's config.timeout should be hoisted to a local variable
    // even though the nested function has a parameter named 'config'
    expect(lua).toContain("local ____config_timeout = config.timeout");
    expect(lua).toContain("local a = ____config_timeout");
    expect(lua).toContain("local b = ____config_timeout");
    expect(lua).toContain("local c = ____config_timeout");
    // The nested function should still exist in output
    expect(lua).toContain("local function inner");
  });

  it("does not hoist a module-scope chain out of an IIFE when the function expression parameter shadows the root", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const value = (function (config: { timeout: number }) {
        return config.timeout + config.timeout;
      })(config);
      `,
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module",
                include: ["config"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      ),
    );

    expect(lua).not.toContain("local ____config_timeout = config.timeout");
    expect(lua).toContain("return config.timeout + config.timeout");
  });

  it("renames a nested function hoist when the generated temp would shadow an enclosing binding", () => {
    const lua = normalizeLua(
      compile(
        `
      declare function use(value: string): void;
      function outer(obj: { x: number }, ____obj_x: string) {
        return (function inner() {
          const a = obj.x;
          const b = obj.x;
          use(____obj_x);
          return a + b;
        })();
      }
      `,
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "function",
                include: ["obj"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      ),
    );

    expect(lua).not.toContain("local ____obj_x = obj.x");
    expect(lua).toContain("local ____obj_x_1 = obj.x");
    expect(lua).toContain("use(____obj_x)");
    expect(lua).toContain("local a = ____obj_x_1");
    expect(lua).toContain("local b = ____obj_x_1");
  });

  it("renames array-element localization temps when they would shadow an enclosing binding", () => {
    const lua = normalizeLua(
      compile(
        `
      function outer(arr: number[], limit: number) {
        const ____arr = 7;
        for (const i of $range(0, limit - 1)) {
          const a = arr[i] + arr[i];
          const b = ____arr + 1;
          if (a > 0) {
            return a + b;
          }
        }
        return 0;
      }
      `,
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "function",
                include: ["arr"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      ),
    );

    expect(lua).not.toContain("local ____arr = arr[i]");
    expect(lua).toContain("local ____arr_1 = arr[i]");
    expect(lua).toContain("local b = ____arr + 1");
    expect(lua).toContain("local a = ____arr_1 + ____arr_1");
  });
});
