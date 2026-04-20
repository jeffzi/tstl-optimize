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

describe("localizer: module-scope hoisting respects nested function scoping", () => {
  it("hoists module-level config.timeout chain when nested function param shadows root (Concern A primary)", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      function inner(config: string) {
        return config.length;
      }
      inner("x");
      `,
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "all",
                include: ["config"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      ),
    );

    // The module-level config.timeout reads should be hoisted
    expect(lua).toContain("local ____config_timeout = config.timeout");
    // Both module-level assignments should use the hoisted var (not config.timeout directly)
    expect(lua).toContain("a = ____config_timeout");
    expect(lua).toContain("b = ____config_timeout");
    // The inner function should still exist and NOT be affected
    expect(lua).toContain("function inner");
  });

  it("hoists outer chain when inner param name differs (Concern A variant — function expression)", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      const fn = function (cfg: { timeout: number }) {
        return cfg.timeout;
      };
      fn(config);
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

    // The outer config.timeout chain should be hoisted (param is named cfg, not config)
    expect(lua).toContain("local ____config_timeout = config.timeout");
    // Both assignments should use the hoisted var
    expect(lua).toContain("a = ____config_timeout");
    expect(lua).toContain("b = ____config_timeout");
  });

  it("hoists module-scope chain even though nested function shadows root (Concern A variant — module scope)", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      function inner(config: string) {
        return config.length;
      }
      inner("x");
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

    // The module-scope config.timeout should be hoisted
    expect(lua).toContain("local ____config_timeout = config.timeout");
    // Both assignments should use the hoisted var
    expect(lua).toContain("a = ____config_timeout");
    expect(lua).toContain("b = ____config_timeout");
  });

  it("does NOT hoist when outer and IIFE reads mix with shadowing (Concern B2)", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      const value = (function (config: { timeout: number }) {
        return config.timeout + config.timeout;
      })({ timeout: 0 });
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

    // MUST NOT hoist because the IIFE's config.timeout refers to the local config
    expect(lua).not.toContain("local ____config_timeout = config.timeout");
    // And the IIFE's config.timeout reads must be present verbatim
    expect(lua).toContain("return config.timeout + config.timeout");
  });

  it("does not rewrite a deeper closure when an ancestor parameter shadows the hoisted root", () => {
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      const readerFactory = (function (config: { timeout: number }) {
        return function () {
          return config.timeout;
        };
      })({ timeout: 0 });
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

    expect(lua).toContain("local ____config_timeout = config.timeout");
    expect(lua).toContain("a = ____config_timeout");
    expect(lua).toContain("b = ____config_timeout");
    expect(lua).toContain("return config.timeout");
    expect(lua).not.toContain("return ____config_timeout");
  });

  it("does not rewrite a grandchild closure when only a non-immediate ancestor shadows the hoisted root", () => {
    // Three-level nesting: the function immediately wrapping the read does NOT
    // shadow `config`; the outer IIFE parameter does. Pre-fix code only checked
    // the top of the shadow stack, so the inner read would be rewritten to the
    // module-level hoisted binding — crossing a parameter boundary and reading
    // the wrong `config`.
    const lua = normalizeLua(
      compile(
        `
      declare const config: { timeout: number };
      const a = config.timeout;
      const b = config.timeout;
      const factory = (function (config: { timeout: number }) {
        return function middle() {
          return function inner() {
            return config.timeout;
          };
        };
      })({ timeout: 0 });
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

    expect(lua).toContain("local ____config_timeout = config.timeout");
    expect(lua).toContain("a = ____config_timeout");
    expect(lua).toContain("b = ____config_timeout");
    expect(lua).toContain("return config.timeout");
    expect(lua).not.toContain("return ____config_timeout");
  });

  it("Concern B1 preserved: does not hoist chain from nested IIFE with shadowing param (existing test)", () => {
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

    // Should not hoist since only the IIFE reads the config chain
    expect(lua).not.toContain("local ____config_timeout = config.timeout");
    expect(lua).toContain("return config.timeout + config.timeout");
  });
});
