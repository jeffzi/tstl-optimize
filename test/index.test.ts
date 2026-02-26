import { describe, expect, it } from "vitest";
import { compile } from "./helpers";

describe("plugin infrastructure", () => {
  it("produces Lua output with default or empty config", () => {
    expect(compile("const x = 1;")).toContain("x = 1");
    expect(compile("const x = 1;", {})).toContain("x = 1");
  });

  it("accepts rules config with disabled rule", () => {
    const lua = compile("const x = 1;", {
      rules: { "const-enum": false },
    });
    expect(lua).toContain("x = 1");
  });
});
