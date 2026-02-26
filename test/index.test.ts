// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { compile } from "./helpers";

describe("plugin infrastructure", () => {
  it("produces Lua output with default or empty config", () => {
    expect(compile("const x = 1;")).toContain("x = 1");
    expect(compile("const x = 1;", {})).toContain("x = 1");
  });

  it("accepts rules config with disabled rule", () => {
    const lua = compile("const x = 1;", {
      rules: { "math-intrinsics": false },
    });
    expect(lua).toContain("x = 1");
  });
});

describe("parseConfig target", () => {
  it("defaults target to undefined when not specified", () => {
    expect(parseConfig().target).toBeUndefined();
    expect(parseConfig({}).target).toBeUndefined();
  });

  it("accepts 'puc' as target", () => {
    expect(parseConfig({ target: "puc" }).target).toBe("puc");
  });

  it("accepts 'luajit' as target", () => {
    expect(parseConfig({ target: "luajit" }).target).toBe("luajit");
  });

  it("ignores invalid target values", () => {
    expect(parseConfig({ target: "v8" }).target).toBeUndefined();
    expect(parseConfig({ target: 42 }).target).toBeUndefined();
    expect(parseConfig({ target: true }).target).toBeUndefined();
  });
});

describe("target auto-detection", () => {
  const SRC = "declare const x: number; const a = Math.floor(x);";

  it("auto-detects puc for Lua51 target and applies math-intrinsics", () => {
    const lua = compile(SRC, { luaTarget: tstl.LuaTarget.Lua51 });
    expect(lua).toContain("% 1");
    expect(lua).not.toContain("math.floor");
  });

  it("auto-detects luajit and skips floor transform", () => {
    const lua = compile(SRC, { luaTarget: tstl.LuaTarget.LuaJIT });
    expect(lua).toContain("math.floor");
  });

  it("explicit target overrides auto-detection", () => {
    // LuaJIT target but explicit puc override → should inline
    const lua = compile(SRC, {
      pluginOptions: { target: "puc" },
      luaTarget: tstl.LuaTarget.LuaJIT,
    });
    expect(lua).toContain("% 1");
    expect(lua).not.toContain("math.floor");
  });
});
