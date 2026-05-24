import { describe, expect, it } from "vitest";
import { getRequireBindings } from "../../src/lua-transforms/require-bindings";

describe("getRequireBindings", () => {
  it("returns map with ____mod → require path for local ____mod = require('mod/path')", () => {
    const lua = `local ____mod = require("mod/path")`;
    const result = getRequireBindings(lua);
    expect(result).toStrictEqual(new Map([["____mod", "mod/path"]]));
  });

  it("returns empty map when source has no require bindings", () => {
    const lua = "local x = 42";
    const result = getRequireBindings(lua);
    expect(result).toStrictEqual(new Map());
  });

  it("ignores non-TSTL variable names without ____ prefix", () => {
    const lua = `local mod = require("mod/path")`;
    const result = getRequireBindings(lua);
    expect(result).toStrictEqual(new Map());
  });

  it("handles multiple require bindings", () => {
    const lua = `
local ____mod1 = require("mod/path1")
local ____mod2 = require("mod/path2")
    `;
    const result = getRequireBindings(lua);
    expect(result).toStrictEqual(
      new Map([
        ["____mod1", "mod/path1"],
        ["____mod2", "mod/path2"],
      ]),
    );
  });

  it("ignores require inside a function body", () => {
    const lua = `
function foo()
  local ____mod = require("mod/path")
end
    `;
    const result = getRequireBindings(lua);
    expect(result).toStrictEqual(new Map());
  });
});
