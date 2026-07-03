import { describe, expect, it } from "vitest";
import { compileWithSourceMap } from "./helpers";
import {
  assertEveryLineMapped,
  assertLineMapsTo,
  assertMapped,
  assertTracebackMapsTo,
  findLuaLine,
  hasAnyMappingOnLine,
  keywordSkip,
  mappingFor,
  RAW_KEYWORD_SKIP,
} from "./sourcemap-helpers";

const SIMPLE_SOURCE = `
const x = 1;
const y = 2;
const z = x + y;
`.trim();

const INVALID_LUA_SOURCE = "// @ts-ignore\nbreak;";

describe("compileWithSourceMap", () => {
  it("returns lua, externalMap, and traceback that map emitted lines", async () => {
    const result = compileWithSourceMap(SIMPLE_SOURCE);
    const luaLine = findLuaLine(result.lua, "x = 1");
    await assertLineMapsTo(result.externalMap, luaLine, 1);
    assertTracebackMapsTo(result.traceback, luaLine, 1);
  });

  it("traceback keys are numeric", () => {
    const { traceback } = compileWithSourceMap(SIMPLE_SOURCE);
    for (const key of Object.keys(traceback)) {
      expect(Number.isInteger(Number(key))).toBe(true);
    }
  });

  it("does not throw for comment-only source", () => {
    // Even empty source should have a __TS__SourceMapTraceBack call;
    // verify it doesn't throw for empty-ish source.
    expect(() => compileWithSourceMap("// comment only")).not.toThrow();
  });

  it("runs the Lua syntax check by default", () => {
    expect(() => compileWithSourceMap(INVALID_LUA_SOURCE)).toThrow(
      /break outside loop|no loop to break/,
    );
  });

  it("skips the Lua syntax check when skipLuaCheck is true", () => {
    expect(() => compileWithSourceMap(INVALID_LUA_SOURCE, { skipLuaCheck: true })).not.toThrow();
  });
});

describe("findLuaLine", () => {
  it("finds a line by substring", () => {
    const lua = "local x = 1\nlocal y = 2\nlocal z = 3\n";
    expect(findLuaLine(lua, "local y")).toBe(2);
  });

  it("finds a line by regex", () => {
    const lua = "local x = 1\nlocal y = 2\n";
    expect(findLuaLine(lua, /local y/)).toBe(2);
  });

  it("throws when no line matches", () => {
    expect(() => findLuaLine("local x = 1\n", "not_present")).toThrow(/findLuaLine/);
  });
});

describe("mappingFor", () => {
  it("returns the original position for a mapped line", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    // "x = 1" targets the actual assignment, not the traceback table literal
    const luaLine = findLuaLine(lua, "x = 1");
    const pos = await mappingFor(externalMap, luaLine);
    expect(pos).toStrictEqual({ line: 1, column: 6, source: "main.ts" });
  });

  it("returns null for unmapped lines", async () => {
    // Line 1 of the external map is typically the header — no mapping.
    const { externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    // We cannot guarantee line 1 is always null (depends on output), but we
    // can verify the helper returns null rather than throwing.
    const pos = await mappingFor(externalMap, 999);
    expect(pos).toBeNull();
  });
});

describe("assertLineMapsTo", () => {
  it("passes when mapping is correct", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    // "x = 1" is the Lua for `const x = 1;` — SIMPLE_SOURCE TS line 1
    const luaLine = findLuaLine(lua, "x = 1");
    await expect(assertLineMapsTo(externalMap, luaLine, 1)).resolves.toBeUndefined();
  });

  it("throws when mapping is wrong", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    const luaLine = findLuaLine(lua, "x = 1");
    await expect(assertLineMapsTo(externalMap, luaLine, 999)).rejects.toThrow(/assertLineMapsTo/);
  });
});

describe("assertTracebackMapsTo", () => {
  it("passes when traceback entry matches", () => {
    const { lua, traceback } = compileWithSourceMap(SIMPLE_SOURCE);
    // "x = 1" is the Lua for `const x = 1;` — TS line 1
    const luaLine = findLuaLine(lua, "x = 1");
    assertTracebackMapsTo(traceback, luaLine, 1);
  });

  it("throws when traceback entry is wrong", () => {
    const { lua, traceback } = compileWithSourceMap(SIMPLE_SOURCE);
    const luaLine = findLuaLine(lua, "x = 1");
    expect(() => assertTracebackMapsTo(traceback, luaLine, 999)).toThrow(/assertTracebackMapsTo/);
  });

  it("throws when line is missing from traceback", () => {
    expect(() => assertTracebackMapsTo({}, 1, 1)).toThrow(/assertTracebackMapsTo/);
  });
});

describe("hasAnyMappingOnLine", () => {
  it("returns true for a mapped line", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    const luaLine = findLuaLine(lua, "x = 1");
    expect(await hasAnyMappingOnLine(externalMap, luaLine)).toBe(true);
  });

  it("returns false for an unmapped line", async () => {
    const { externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    expect(await hasAnyMappingOnLine(externalMap, 999)).toBe(false);
  });
});

describe("assertMapped", () => {
  it("returns the original position for a mapped column", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    const luaLine = findLuaLine(lua, "x = 1");
    const pos = await assertMapped(externalMap, luaLine, 4);
    expect(pos).toStrictEqual({ line: 1, column: 10, source: "main.ts" });
  });

  it("throws for an unmapped line", async () => {
    const { externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    await expect(assertMapped(externalMap, 999)).rejects.toThrow(/assertMapped/);
  });
});

describe("RAW_KEYWORD_SKIP and keywordSkip", () => {
  it.each(["do", "end", "else"])("RAW_KEYWORD_SKIP contains '%s'", (keyword) => {
    expect(RAW_KEYWORD_SKIP.has(keyword)).toBe(true);
  });

  it.each([
    { line: "  do  ", expected: true },
    { line: "  end", expected: true },
    { line: "else", expected: true },
    { line: "  local x = 1", expected: false },
  ])("keywordSkip($line) → $expected", ({ line, expected }) => {
    const skip = keywordSkip(RAW_KEYWORD_SKIP);
    expect(skip(line)).toBe(expected);
  });
});

describe("assertEveryLineMapped", () => {
  it("passes when all lines in range are mapped", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    // Use content-anchored lines — skip the __TS__SourceMapTraceBack header (line 1)
    const startLine = findLuaLine(lua, "x = 1");
    const endLine = findLuaLine(lua, "x + y");
    await expect(
      assertEveryLineMapped(externalMap, lua, { start: startLine, end: endLine }),
    ).resolves.toBeUndefined();
  });

  it("skips lines matching the skip predicate", async () => {
    const { lua, externalMap } = compileWithSourceMap(SIMPLE_SOURCE);
    const headerLine = 1;
    const headerText = lua.split("\n")[headerLine - 1] ?? "";

    // Line 1 (__TS__SourceMapTraceBack call) is unmapped — without skip it rejects.
    await expect(
      assertEveryLineMapped(externalMap, lua, { start: headerLine, end: headerLine }),
    ).rejects.toThrow("have no mapping");

    // With a skip that exempts only the header line, it resolves.
    await expect(
      assertEveryLineMapped(
        externalMap,
        lua,
        { start: headerLine, end: headerLine },
        {
          skip: (line) => line === headerText,
        },
      ),
    ).resolves.toBeUndefined();
  });
});
