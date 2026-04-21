/**
 * Unit tests for the runtime detection and assertion helpers.
 *
 * Mocks `node:child_process` so no real Lua binaries are required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mock — must be hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

vi.mock("node:child_process");

import { spawnSync } from "node:child_process";
import {
  _resetRuntimeCache,
  assertExpectedRuntimes,
  detectRuntimes,
  type LuaRuntime,
} from "./helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENV_LUA_51 = "LUA_51";
const ENV_LUA_JIT = "LUA_JIT";
const ENV_LUA_JIT_NOJIT = "LUA_JIT_NOJIT";
const LABEL_LUAJIT_NOJIT = "luajit-nojit";
const ARG_JOFF = "-joff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base mock return value for spawnSync calls. */
const BASE_SPAWN_SYNC_RESULT = {
  pid: 0,
  output: [],
  signal: null,
};

/** Make spawnSync return a successful probe response (binary found). */
function mockBinaryFound(): void {
  vi.mocked(spawnSync).mockReturnValue({
    ...BASE_SPAWN_SYNC_RESULT,
    stdout: "LuaJIT 2.1.0",
    stderr: "",
    status: 0,
    error: undefined,
  });
}

/** Make spawnSync return an error response (binary not found). */
function mockBinaryNotFound(): void {
  vi.mocked(spawnSync).mockReturnValue({
    ...BASE_SPAWN_SYNC_RESULT,
    stdout: "",
    stderr: "",
    status: null,
    error: new Error("ENOENT"),
  });
}

/** Stub env vars for a clean runtime detection test (all runtimes unset). */
function stubAllRuntimeEnvsEmpty(): void {
  vi.stubEnv(ENV_LUA_51, "");
  vi.stubEnv(ENV_LUA_JIT, "");
  vi.stubEnv(ENV_LUA_JIT_NOJIT, "");
}

/** Find a runtime by label or return undefined. */
function findRuntimeByLabel(runtimes: LuaRuntime[], label: string) {
  return runtimes.find((r) => r.label === label);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetRuntimeCache();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// detectRuntimes — luajit-nojit candidate
// ---------------------------------------------------------------------------

describe("detectRuntimes", () => {
  describe("luajit-nojit candidate", () => {
    it("returns runtime with label 'luajit-nojit' and args ['-joff'] when LUA_JIT_NOJIT is set", () => {
      stubAllRuntimeEnvsEmpty();
      vi.stubEnv(ENV_LUA_JIT_NOJIT, "/usr/bin/luajit");
      mockBinaryFound();

      const runtimes = detectRuntimes();
      const nojit = findRuntimeByLabel(runtimes, LABEL_LUAJIT_NOJIT);

      expect(nojit).toBeDefined();
      expect(nojit?.args).toStrictEqual([ARG_JOFF]);
    });

    it("does not return a luajit-nojit entry when LUA_JIT_NOJIT is unset", () => {
      stubAllRuntimeEnvsEmpty();
      mockBinaryNotFound();

      const runtimes = detectRuntimes();
      const nojit = findRuntimeByLabel(runtimes, LABEL_LUAJIT_NOJIT);

      expect(nojit).toBeUndefined();
    });
  });

  describe("dedup with same binary path", () => {
    it("registers both luajit and luajit-nojit when LUA_JIT and LUA_JIT_NOJIT point to the same binary", () => {
      vi.stubEnv(ENV_LUA_JIT, "luajit");
      vi.stubEnv(ENV_LUA_JIT_NOJIT, "luajit");
      vi.stubEnv(ENV_LUA_51, "");
      mockBinaryFound();

      const runtimes = detectRuntimes();
      const labels = runtimes.map((r) => r.label);

      expect(labels).toContain("luajit");
      expect(labels).toContain(LABEL_LUAJIT_NOJIT);
    });
  });

  describe("luajit identity checks", () => {
    it("does not classify plain lua as luajit when only lua responds", () => {
      stubAllRuntimeEnvsEmpty();
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "Lua 5.4.7",
          stderr: "",
          status: 0,
          error: undefined,
        });

      const runtimes = detectRuntimes();

      expect(findRuntimeByLabel(runtimes, "luajit")).toBeUndefined();
    });

    it("accepts a lua fallback when it identifies itself as LuaJIT", () => {
      stubAllRuntimeEnvsEmpty();
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "",
          stderr: "",
          status: null,
          error: new Error("ENOENT"),
        })
        .mockReturnValueOnce({
          ...BASE_SPAWN_SYNC_RESULT,
          stdout: "LuaJIT 2.1.0-beta3",
          stderr: "",
          status: 0,
          error: undefined,
        });

      const runtimes = detectRuntimes();

      expect(findRuntimeByLabel(runtimes, "luajit")).toStrictEqual({
        label: "luajit",
        cmd: "lua",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// assertExpectedRuntimes
// ---------------------------------------------------------------------------

describe("assertExpectedRuntimes", () => {
  describe("when LUA_EXPECT is empty or unset", () => {
    beforeEach(() => {
      vi.stubEnv("LUA_EXPECT", "");
    });

    it("passes when runtimes.length > 0", () => {
      const runtimes = [{ label: "lua5.1", cmd: "lua5.1" }];
      expect(() => assertExpectedRuntimes(runtimes)).not.toThrow();
    });

    it("throws when runtimes array is empty", () => {
      expect(() => assertExpectedRuntimes([])).toThrow();
    });
  });

  describe("when LUA_EXPECT is set", () => {
    it("passes when all listed labels are present in runtimes", () => {
      vi.stubEnv("LUA_EXPECT", LABEL_LUAJIT_NOJIT);
      const runtimes = [{ label: LABEL_LUAJIT_NOJIT, cmd: "luajit", args: [ARG_JOFF] }];
      expect(() => assertExpectedRuntimes(runtimes)).not.toThrow();
    });

    it("throws and names missing labels when a listed label is absent", () => {
      vi.stubEnv("LUA_EXPECT", `lua5.1,${LABEL_LUAJIT_NOJIT}`);
      const runtimes = [{ label: "lua5.1", cmd: "lua5.1" }];
      expect(() => assertExpectedRuntimes(runtimes)).toThrow(LABEL_LUAJIT_NOJIT);
    });
  });
});
