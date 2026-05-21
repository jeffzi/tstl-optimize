import { describe, expect, it } from "vitest";
import { getModuleExports } from "../../src/lua-transforms/module-exports";

describe("getModuleExports", () => {
  it("returns set with 'foo' for function ____exports.foo() end", () => {
    const lua = "function ____exports.foo() end";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["foo"]));
  });

  it("returns set with 'foo' for ____exports.foo = 42", () => {
    const lua = "____exports.foo = 42";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["foo"]));
  });

  it('returns set with "foo" for ____exports["foo"] = 42', () => {
    const lua = `____exports["foo"] = 42`;
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["foo"]));
  });

  it("returns set with 'foo' for ____exports.foo = ____exports.foo or {}", () => {
    const lua = "____exports.foo = ____exports.foo or {}";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["foo"]));
  });

  it("does NOT add from nested write ____exports.foo.bar = 42", () => {
    const lua = "____exports.foo.bar = 42";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("returns empty set when no exports", () => {
    const lua = "local x = 42";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("collects multiple export names from multiple statements", () => {
    const lua = `
function ____exports.foo() end
____exports.bar = 42
____exports["baz"] = "value"
    `;
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["foo", "bar", "baz"]));
  });

  it("ignores function with non-____exports identifier", () => {
    const lua = "function foo() end";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("ignores assignment where LHS is not ____exports", () => {
    const lua = "local exports = { foo = 42 }";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("ignores bracket notation with non-____exports base", () => {
    const lua = `exports["foo"] = 42`;
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("ignores bracket notation with non-string-literal key", () => {
    const lua = "____exports[x] = 42";
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("ignores function with no identifier", () => {
    const lua = `
local function foo() end
    `;
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set());
  });

  it("handles mixed assignment and function declarations", () => {
    const lua = `
function ____exports.alpha() end
____exports.beta = true
function notExports.gamma() end
____exports["delta"] = nil
    `;
    const result = getModuleExports(lua);
    expect(result).toStrictEqual(new Set(["alpha", "beta", "delta"]));
  });
});
