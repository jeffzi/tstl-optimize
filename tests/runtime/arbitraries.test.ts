import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbIdent, isValidDeclarationIdentifier } from "./arbitraries";

describe("isValidDeclarationIdentifier", () => {
  it.each(["foo", "_", "__", "a1", "x_y", "camelCase"])("accepts valid identifier %s", (name) => {
    expect(isValidDeclarationIdentifier(name)).toBe(true);
  });

  it.each([
    "1foo",
    "if",
    "for",
    "while",
    "return",
    "class",
    "function",
    "const",
    "var",
    "void",
    "new",
    "foo bar",
    "foo-bar",
  ])("rejects invalid identifier %s", (name) => {
    expect(isValidDeclarationIdentifier(name)).toBe(false);
  });
});

describe("arbIdent", () => {
  it("never produces a TypeScript reserved word", () => {
    const samples = fc.sample(arbIdent, 200);
    const reserved = ["if", "for", "while", "return", "class", "function", "const", "let", "var"];
    for (const keyword of reserved) {
      expect(samples).not.toContain(keyword);
    }
  });
});
