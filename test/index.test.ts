import { describe, expect, it } from "vitest";
import plugin from "../src/index";

describe("plugin", () => {
  it("should export a valid plugin", () => {
    expect(plugin).toBeDefined();
  });
});
