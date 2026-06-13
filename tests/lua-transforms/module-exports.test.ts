import { describe, expect, it } from "vitest";
import { getModuleExports } from "../../src/lua-transforms/module-exports";

describe("getModuleExports", () => {
  describe("when parsing function declarations", () => {
    it("extracts member name from function ____exports.foo() end", () => {
      const lua = "function ____exports.foo() end";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set(["foo"]));
    });
  });

  describe("when parsing property assignments", () => {
    it("extracts member name from ____exports.foo = 42", () => {
      const lua = "____exports.foo = 42";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set(["foo"]));
    });

    it("extracts member name from ____exports.foo = ____exports.foo or {}", () => {
      const lua = "____exports.foo = ____exports.foo or {}";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set(["foo"]));
    });
  });

  describe("when parsing bracket notation", () => {
    it('extracts member name from ____exports["foo"] = 42', () => {
      const lua = `____exports["foo"] = 42`;
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set(["foo"]));
    });
  });

  describe("when source has nested member access", () => {
    it("does NOT extract from nested write ____exports.foo.bar = 42", () => {
      const lua = "____exports.foo.bar = 42";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set());
    });
  });

  describe("when source has no exports", () => {
    it("returns empty set for local x = 42", () => {
      const lua = "local x = 42";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set());
    });
  });

  describe("when parsing multiple export statements", () => {
    it("collects all export names from mixed function and assignment patterns", () => {
      const lua = `
function ____exports.foo() end
____exports.bar = 42
____exports["baz"] = "value"
      `;
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set(["foo", "bar", "baz"]));
    });
  });

  describe("when parsing non-export identifiers", () => {
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

    it("ignores function with no identifier", () => {
      const lua = `
local function foo() end
      `;
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set());
    });
  });

  describe("when parsing bracket notation with invalid keys", () => {
    it("ignores bracket notation with non-string-literal key", () => {
      const lua = "____exports[x] = 42";
      const result = getModuleExports(lua);
      expect(result).toStrictEqual(new Set());
    });
  });

  describe("when parsing mixed exports and non-exports", () => {
    it("extracts only ____exports entries, ignoring other identifiers", () => {
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
});
