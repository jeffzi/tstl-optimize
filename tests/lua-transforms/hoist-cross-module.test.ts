import { describe, expect, it } from "vitest";
import { hoistCrossModuleAccesses } from "../../src/lua-transforms/hoist-cross-module";

describe("hoistCrossModuleAccesses", () => {
  describe("when source has no require bindings", () => {
    it("returns unchanged source and empty map", () => {
      const source = "local x = 1\nlocal y = 2";
      const result = hoistCrossModuleAccesses(source);
      expect(result.source).toStrictEqual(source);
      expect(result.localizedSymbols.size).toBe(0);
    });
  });

  describe("when require bindings exist but no member accesses", () => {
    it("returns unchanged source and empty map", () => {
      const source = 'local ____mod = require("my/mod")';
      const result = hoistCrossModuleAccesses(source);
      expect(result.source).toStrictEqual(source);
      expect(result.localizedSymbols.size).toBe(0);
    });
  });

  describe("basic hoisting: single member access", () => {
    it("inserts local after require, rewrites reference", () => {
      const source = 'local ____mod = require("my/mod")\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      const expected = 'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nprint(foo)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });
  });

  describe("multiple members from same module", () => {
    it("inserts one local per member, ordered by first reference", () => {
      const source = 'local ____mod = require("my/mod")\nprint(____mod.bar)\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal bar = ____mod.bar\nlocal foo = ____mod.foo\nprint(bar)\nprint(foo)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });
  });

  describe("multiple modules", () => {
    it("inserts locals after respective require lines", () => {
      const source =
        'local ____a = require("mod/a")\nlocal ____b = require("mod/b")\nprint(____a.x)\nprint(____b.y)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____a = require("mod/a")\nlocal x = ____a.x\nlocal ____b = require("mod/b")\nlocal y = ____b.y\nprint(x)\nprint(y)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("x")).toStrictEqual({
        moduleVar: "____a",
        memberName: "x",
      });
      expect(result.localizedSymbols.get("y")).toStrictEqual({
        moduleVar: "____b",
        memberName: "y",
      });
    });
  });

  describe("declaration LHS skipping: function declaration", () => {
    it("does not rewrite function identifier, no locals inserted", () => {
      const source = 'local ____exports = require("____exports")\nfunction ____exports.foo()\nend';
      const result = hoistCrossModuleAccesses(source);
      expect(result.source).toStrictEqual(source);
      expect(result.localizedSymbols.size).toBe(0);
    });
  });

  describe("declaration LHS skipping: assignment LHS", () => {
    it("does not rewrite assignment LHS, rewrites RHS reference", () => {
      const source = 'local ____mod = require("my/mod")\n____mod.bar = 42\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal bar = ____mod.bar\n____mod.bar = 42\nprint(bar)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.size).toBe(1);
    });
  });

  describe("collision detection: two modules same member name", () => {
    it("throws when two modules contribute the same bare name", () => {
      const source =
        'local ____a = require("mod/a")\nlocal ____b = require("mod/b")\nprint(____a.foo)\nprint(____b.foo)';
      expect(() => {
        hoistCrossModuleAccesses(source);
      }).toThrow();
    });
  });

  describe("collision detection: hoisted name shadows existing local", () => {
    it("throws when hoisted name would shadow chunk-level local", () => {
      const source = 'local foo = 1\nlocal ____mod = require("my/mod")\nprint(____mod.foo)';
      expect(() => {
        hoistCrossModuleAccesses(source);
      }).toThrow();
    });
  });

  describe("idempotency: already-hoisted source", () => {
    it("returns byte-identical output for single pre-existing hoist", () => {
      const source = 'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nprint(foo)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.source).toStrictEqual(source);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("recognizes multiple consecutive pre-existing hoists", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal bar = ____mod.bar\nlocal foo = ____mod.foo\nprint(bar)\nprint(foo)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.source).toStrictEqual(source);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("stops recognizing pre-existing hoists at first non-matching local", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nlocal unrelated = 5\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
    });
  });

  describe("look-alike local appearing LATER (not immediately after require)", () => {
    it("throws because the later local creates collision", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal x = 1\nlocal foo = ____mod.foo\nprint(____mod.foo)';
      expect(() => {
        hoistCrossModuleAccesses(source);
      }).toThrow();
    });
  });

  describe("determinism: same input produces identical output", () => {
    it("calling twice on same source yields byte-identical result", () => {
      const source = 'local ____mod = require("my/mod")\nprint(____mod.foo)';
      const result1 = hoistCrossModuleAccesses(source);
      const result2 = hoistCrossModuleAccesses(source);
      expect(result2.source).toStrictEqual(result1.source);
      expect(result2.localizedSymbols.size).toBe(result1.localizedSymbols.size);
    });
  });

  describe("localizedSymbols describes post-transform state", () => {
    it("includes both pre-existing and fresh hoists in the map", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
    });
  });

  describe("trailing newline handling: insertion at start of next line", () => {
    it("handles require with trailing comment correctly", () => {
      const source = 'local ____mod = require("my/mod") -- this is a module\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod") -- this is a module\nlocal foo = ____mod.foo\nprint(foo)';
      expect(result.source).toStrictEqual(expected);
    });
  });

  describe("error messages", () => {
    it("collision error includes conflicting name and module vars", () => {
      const source =
        'local ____a = require("mod/a")\nlocal ____b = require("mod/b")\nprint(____a.foo)\nprint(____b.foo)';
      expect(() => {
        hoistCrossModuleAccesses(source);
      }).toThrow(/foo/);
    });

    it("shadowing error mentions the conflicting name", () => {
      const source = 'local foo = 1\nlocal ____mod = require("my/mod")\nprint(____mod.foo)';
      expect(() => {
        hoistCrossModuleAccesses(source);
      }).toThrow(/foo/);
    });
  });

  describe("mixed Lua constructs alongside require-bound accesses", () => {
    it("hoists correctly when a regular function declaration is present", () => {
      const source =
        'local ____mod = require("my/mod")\nfunction regularFunc()\nend\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal bar = ____mod.bar\nfunction regularFunc()\nend\nprint(bar)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
    });

    it("hoists correctly when an assignment to a plain identifier is present", () => {
      const source = 'local ____mod = require("my/mod")\nx = 42\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal bar = ____mod.bar\nx = 42\nprint(bar)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.get("bar")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "bar",
      });
    });

    it("hoists inner member when a chained member access like ____mod.foo.bar is present", () => {
      const source = 'local ____mod = require("my/mod")\nlocal x = ____mod.foo.bar';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nlocal x = foo.bar';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("only hoists require-bound accesses, leaves non-require-bound members unchanged", () => {
      const source = 'local ____mod = require("my/mod")\nprint(math.max(____mod.x, 1))';
      const result = hoistCrossModuleAccesses(source);
      const expected =
        'local ____mod = require("my/mod")\nlocal x = ____mod.x\nprint(math.max(x, 1))';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("x")).toBeDefined();
    });
  });

  describe("source with no newline after require statement", () => {
    it("inserts hoist after require (before first use) when no newline follows require", () => {
      const source = 'local ____mod = require("my/mod")print(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      const expected = 'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nprint(foo)';
      expect(result.source).toStrictEqual(expected);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("multi-line sources preserve byte-identical behavior", () => {
      const source = 'local ____mod = require("my/mod")\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      const expected = 'local ____mod = require("my/mod")\nlocal foo = ____mod.foo\nprint(foo)';
      expect(result.source).toStrictEqual(expected);
    });
  });

  describe("nested expressions", () => {
    it("hoists member accesses within nested expressions", () => {
      const source = 'local ____mod = require("my/mod")\nlocal x = { a = ____mod.foo, b = 2 }';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("hoists member accesses within conditional blocks", () => {
      const source = 'local ____mod = require("my/mod")\nif ____mod.flag then\n  print("yes")\nend';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("flag")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "flag",
      });
    });

    it("stops at non-pattern locals in pre-existing hoist block (multiple vars)", () => {
      const source = 'local ____mod = require("my/mod")\nlocal a, b = 1, 2\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("stops at non-pattern locals in pre-existing hoist block (single init)", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal a, b = someFunc()\nprint(____mod.foo)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(1);
      expect(result.localizedSymbols.get("foo")).toStrictEqual({
        moduleVar: "____mod",
        memberName: "foo",
      });
    });

    it("stops at locals with multiple inits", () => {
      const source =
        'local ____mod = require("my/mod")\nlocal baz = ____mod.foo, extra\nprint(____mod.bar)';
      const result = hoistCrossModuleAccesses(source);
      expect(result.localizedSymbols.size).toBe(2);
      expect(result.localizedSymbols.get("foo")).toBeDefined();
      expect(result.localizedSymbols.get("bar")).toBeDefined();
    });
  });
});
