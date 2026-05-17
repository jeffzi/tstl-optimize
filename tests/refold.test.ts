import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "./helpers";

describe("refold phase", () => {
  describe("cross-rule win — localizer + merge-locals", () => {
    it("merges consecutive locals introduced by localizer hoisting", () => {
      // Localizer (hoist phase) rewrites obj.y accesses to a hoisted local,
      // producing consecutive `local d = ...; local e = ...; local f = ...`.
      // merge-locals (eliminate phase) already ran before localizer, so it
      // missed this opportunity. Refold re-runs merge-locals and catches it.
      const source = [
        "declare const obj: { x: number; y: number; z: number };",
        "declare const cond1: boolean;",
        "declare const cond2: boolean;",
        "function process() {",
        "  if (cond1) {",
        "    return obj.x + obj.x;",
        "  } else if (cond2) {",
        "    const d = obj.y;",
        "    const e = obj.y;",
        "    const f = obj.y;",
        "    return d + e + f;",
        "  } else {",
        "    return obj.z + obj.z;",
        "  }",
        "}",
      ].join("\n");

      const lua = normalizeLua(
        compile(source, {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["obj"] } },
          },
        }),
      );

      expect(lua).toContain("local d, e, f = ____obj_y, ____obj_y, ____obj_y");
    });

    it("merges locals introduced by localizer with parameter shadowing", () => {
      const source = [
        "declare const config: { width: number; height: number };",
        "function resize(config: { width: number; height: number }) {",
        "  const w = config.width;",
        "  const h = config.height;",
        "  const area = config.width * config.height;",
        "  return w + h + area;",
        "}",
      ].join("\n");

      const lua = normalizeLua(
        compile(source, {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["config"] } },
          },
        }),
      );

      expect(lua).toContain("local w, h");
    });
  });

  describe("idempotency", () => {
    it("does not alter already-optimal code", () => {
      const lua = normalizeLua(
        compile(["const x = 42;", "function foo() {", "  return x + 1;", "}"].join("\n")),
      );

      expect(lua).toContain("x = 42");
      expect(lua).toContain("return x + 1");
    });
  });

  describe("disabled-rule respect", () => {
    it("does not run constant-folding in refold when globally disabled", () => {
      const lua = normalizeLua(
        compile("const x = 1 + 2;", {
          pluginOptions: { rules: { "constant-folding": false } },
        }),
      );

      expect(lua).toContain("1 + 2");
      expect(lua).not.toContain("x = 3");
    });
  });
});
