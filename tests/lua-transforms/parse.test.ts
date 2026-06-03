import { describe, expect, it } from "vitest";
import {
  collectExistingLocals,
  collectRequireBindings,
  parseLua,
} from "../../src/lua-transforms/parse";

describe("parseLua", () => {
  it("returns a Chunk node with correct body for valid Lua", () => {
    const source = "local x = 1";
    const ast = parseLua(source);
    expect(ast.type).toBe("Chunk");
    expect(Array.isArray(ast.body)).toBe(true);
  });

  it("throws on syntax errors with message that includes the source", () => {
    const source = "local x = ";
    expect(() => parseLua(source)).toThrow(source);
  });

  it("the returned AST has ranges on each node", () => {
    const source = "local x = 1";
    const ast = parseLua(source);
    // @types/luaparse omits `range` from the Base type despite its runtime presence.
    // Cast through `unknown` first to satisfy the type checker.
    const range: unknown = (ast as unknown as Record<string, unknown>).range;
    expect(Array.isArray(range)).toBe(true);
    expect((range as unknown[]).length).toBe(2);
  });
});

describe("collectRequireBindings", () => {
  it("returns a map with one entry for local ____mod = require('mod/path')", () => {
    const source = "local ____mod = require('mod/path')";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(1);
    expect(bindings.has("____mod")).toBe(true);
    const binding = bindings.get("____mod");
    expect(binding).toBeDefined();
    expect(binding?.path).toBe("mod/path");
    expect(binding?.node).toBeDefined();
  });

  it("returns empty map when there are no require statements", () => {
    const source = "local x = 1";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(0);
  });

  it("returns empty map for local mod = require('x') (name doesn't start with ____)", () => {
    const source = "local mod = require('x')";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(0);
  });

  it("ignores multi-variable: local ____a, ____b = require('x'), require('y')", () => {
    const source = "local ____a, ____b = require('x'), require('y')";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    // Should skip this entirely because it has more than one variable
    expect(bindings.size).toBe(0);
  });

  it("ignores non-require call: local ____mod = notRequire('x')", () => {
    const source = "local ____mod = notRequire('x')";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(0);
  });

  it("ignores non-string arg: local ____mod = require(someVar)", () => {
    const source = "local ____mod = require(someVar)";
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(0);
  });

  it("handles multiple require bindings — returns all matching ones", () => {
    const source = `
      local ____mod1 = require('path/one')
      local ____mod2 = require('path/two')
      local other = 5
    `;
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    expect(bindings.size).toBe(2);
    expect(bindings.get("____mod1")?.path).toBe("path/one");
    expect(bindings.get("____mod2")?.path).toBe("path/two");
  });

  it("ignores nested requires (inside a function body, not at chunk level)", () => {
    const source = `
      function foo()
        local ____mod = require('nested')
      end
      local ____global = require('global')
    `;
    const ast = parseLua(source);
    const bindings = collectRequireBindings(ast);
    // Should only find the chunk-level one
    expect(bindings.size).toBe(1);
    expect(bindings.has("____global")).toBe(true);
  });
});

describe("collectExistingLocals", () => {
  it("returns a set of all variable names in chunk-level locals", () => {
    const source = "local x, y = 1, 2";
    const ast = parseLua(source);
    const locals = collectExistingLocals(ast);
    expect(locals.size).toBe(2);
    expect(locals.has("x")).toBe(true);
    expect(locals.has("y")).toBe(true);
  });

  it("ignores variables inside function bodies (not chunk level)", () => {
    const source = `
      local globalX = 1
      function foo()
        local localY = 2
      end
    `;
    const ast = parseLua(source);
    const locals = collectExistingLocals(ast);
    expect(locals.size).toBe(1);
    expect(locals.has("globalX")).toBe(true);
    expect(locals.has("localY")).toBe(false);
  });

  it("returns empty set when no locals", () => {
    const source = "x = 1";
    const ast = parseLua(source);
    const locals = collectExistingLocals(ast);
    expect(locals.size).toBe(0);
  });
});
