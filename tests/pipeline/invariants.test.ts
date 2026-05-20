import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

// Guard against structural regressions in the full optimization pipeline.
// Each case exercises a rule combination that historically produced forbidden
// output patterns when rules ran in the wrong order (.research/issues.md).

type InvariantCase = {
  name: string;
  source: string;
  // Empty object means "use default plugin options".
  pluginOptions: Record<string, unknown>;
};

function ccConstants(name: string, env: string, defaultValue: boolean): Record<string, unknown> {
  return {
    rules: { "conditional-compilation": { constants: { [name]: { env, default: defaultValue } } } },
  };
}

const CASES: InvariantCase[] = [
  {
    // conditional-compilation folds !DEBUG=false → do local safeHp = hp end, then dead-local
    // removes safeHp → do end. The cleanup phase must then remove the empty block.
    name: "conditional-compilation + dead-local",
    source: `
      declare const DEBUG: boolean;
      declare const hp: number;
      if (!DEBUG) { const safeHp = hp; }
    `,
    pluginOptions: ccConstants("DEBUG", "TSTL_OPT_INV_DEBUG", false),
  },
  {
    // Parallel shape: two dead locals inside a folded branch. Exercises the same
    // phase-ordering constraint as the case above, with merge-locals also in scope.
    name: "conditional-compilation + merge-locals",
    source: `
      declare const PROD: boolean;
      declare const a: number;
      declare const b: number;
      if (!PROD) { const x = a; const y = b; }
    `,
    pluginOptions: ccConstants("PROD", "TSTL_OPT_INV_PROD", false),
  },
  {
    // Inline runs after dead-local in the phase order. If inline emits a do-block
    // for an already-emptied function body, remove-empty-branch has already passed
    // and the empty block would survive. Verify the inline rule handles this correctly.
    name: "inline + dead-local",
    source: `
      /** @inline */
      function process(x: number): void {
        const dead = x + 1;
      }
      declare const n: number;
      process(n);
    `,
    pluginOptions: {},
  },
  {
    // Localizer hoists obj.x to a local inside a conditional branch.
    // The refold phase re-runs dead-local + remove-empty-branch, which should
    // remove the unused hoisted local and then eliminate the empty if-block.
    name: "refold + localizer artifacts",
    source: `
      declare const obj: { x: number };
      declare const cond: boolean;
      function fn() {
        if (cond) {
          const dead = obj.x;
        }
      }
    `,
    pluginOptions: { rules: { localizer: { scope: "function", include: ["obj"] } } },
  },
  {
    // Inline a function with an optional parameter where trailing args are omitted.
    // The inlined body should not leave any empty block residue.
    name: "inline + optional params",
    source: `
      /** @inline */
      function greet(name: string, suffix?: string): string {
        return name + (suffix ?? "");
      }
      declare const n: string;
      const result = greet(n);
    `,
    pluginOptions: {},
  },
  {
    // Inline a function that uses a computed const expression (2 ** BITS).
    // The refold pass re-runs constant-folding, so the result must be fully
    // folded — no if-true, no unfolded arithmetic surviving.
    name: "inline + cross-module const folding",
    source: `
      const BITS = 8;
      const MAX = 2 ** BITS;
      /** @inline */
      function isValid(x: number): boolean {
        return x < MAX;
      }
      declare const n: number;
      const ok = isValid(n);
    `,
    pluginOptions: {},
  },
  {
    // Math intrinsics folds Math.ceil(2.3) and Math.round(2.7) to literals.
    // After folding, no math.ceil or math.round call should appear in Lua output,
    // and no if-true/if-false residue.
    name: "math-intrinsics + constant-folding",
    source: `
      const a = Math.ceil(2.3);
      const b = Math.round(2.7);
    `,
    pluginOptions: {},
  },
];

// Each pattern documents why it is forbidden.
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "empty do-end (same line)",
    // A bare do-end with only whitespace between is a stale empty block.
    pattern: /\bdo\s+end\b/,
  },
  {
    label: "unfolded if-true branch",
    // conditional-compilation or constant-folding should eliminate these.
    pattern: /\bif\s+true\s+then\b/,
  },
  {
    label: "unfolded if-false branch",
    // Dead branch that should have been stripped.
    pattern: /\bif\s+false\s+then\b/,
  },
];

/**
 * Returns one diagnostic string per violation. Embeds the offending line for
 * easy diagnosis when an assertion fails.
 */
function findViolations(lua: string): string[] {
  const lines = lua.split("\n");
  const violations: string[] = [];

  for (const { label, pattern } of FORBIDDEN) {
    for (const [lineIndex, line] of lines.entries()) {
      if (pattern.test(line)) {
        violations.push(`line ${lineIndex + 1} [${label}]: ${line.trim()}`);
      }
    }
  }

  // Multiline empty do-end: "do" line immediately followed by "end" line
  // after stripping blank lines and trimming whitespace.
  const normalized = normalizeLua(lua).split("\n");
  for (const [lineIndex, line] of normalized.entries()) {
    const nextLine = normalized[lineIndex + 1];
    if (nextLine === undefined) {
      break;
    }
    if (line === "do" && nextLine === "end") {
      violations.push(
        `normalized lines ${lineIndex + 1}–${lineIndex + 2}: empty multiline do-end block`,
      );
    }
  }

  return violations;
}

describe("full-pipeline structural invariants", () => {
  it.each(CASES)("$name emits no forbidden patterns", ({ source, pluginOptions }) => {
    const lua = compile(source, { pluginOptions });
    const violations = findViolations(lua);
    expect(violations, `Lua output:\n${lua}`).toStrictEqual([]);
  });
});
