import { SourceMapConsumer } from "source-map";
import type { TracebackTable } from "./helpers";

export type { TracebackTable };

/**
 * Lines whose entire trimmed content is one of these tokens are exempt from
 * sourcemap coverage. The skip is text-based and context-blind: TSTL emits
 * these keywords as raw string chunks without a createSourceNode call, so no
 * mapping is produced regardless of the surrounding AST node.
 *
 * Sources:
 * - `do`/`end` for DoStatement (LuaPrinter.js:304)
 * - `else` and closing `end` for IfStatement (LuaPrinter.js:356)
 * - Same raw style for WhileStatement, numeric ForStatement closing `end`
 *
 * Adding a token requires a fresh LuaPrinter.js citation in this comment.
 */
export const RAW_KEYWORD_SKIP: ReadonlySet<string> = new Set(["do", "end", "else"]);

/**
 * Factory returning a skip predicate for `assertEveryLineMapped` that matches
 * lines whose trimmed content is in `set`.
 *
 * Usage: `assertEveryLineMapped(map, lua, range, { skip: keywordSkip(RAW_KEYWORD_SKIP) })`
 */
export function keywordSkip(set: ReadonlySet<string>): (line: string) => boolean {
  return (line: string) => set.has(line.trim());
}

/** Wraps a callback with a properly-disposed SourceMapConsumer. */
async function withConsumer<T>(rawMap: string, fn: (consumer: SourceMapConsumer) => T): Promise<T> {
  return SourceMapConsumer.with(rawMap, null, fn);
}

/**
 * Look up the original position for a Lua location.
 *
 * Line numbers are **1-based** throughout, matching editor conventions and what
 * TSTL's traceback table and `originalPositionFor` both return.
 */
export async function mappingFor(
  rawMap: string,
  luaLine: number,
  luaColumn = 0,
): Promise<{ line: number; column: number; source: string } | null> {
  return withConsumer(rawMap, (consumer) => {
    const pos = consumer.originalPositionFor({ line: luaLine, column: luaColumn });
    if (pos.line === null || pos.source === null) return null;
    return { line: pos.line, column: pos.column ?? 0, source: pos.source };
  });
}

/**
 * Locate a Lua line by content.
 *
 * Returns the **1-based** line number of the first line matching `predicate`.
 * Throws if no line matches — tests must pin assertions to stable token sequences.
 */
export function findLuaLine(lua: string, predicate: string | RegExp): number {
  const lines = lua.split("\n");
  const test =
    typeof predicate === "string"
      ? (l: string) => l.includes(predicate)
      : (l: string) => predicate.test(l);

  for (let i = 0; i < lines.length; i++) {
    if (test(lines[i] ?? "")) return i + 1;
  }
  throw new Error(`findLuaLine: no line matches ${String(predicate)}\n\nLua output:\n${lua}`);
}

/**
 * Assert that the external `.lua.map` maps `luaLine` to `expectedTsLine`.
 *
 * Both line numbers are **1-based**.
 *
 * Callers must derive `luaLine` from `findLuaLine` (content-anchored) rather
 * than from absolute positions so assertions survive minor output drift.
 */
export async function assertLineMapsTo(
  rawMap: string,
  luaLine: number,
  expectedTsLine: number,
): Promise<void> {
  const pos = await mappingFor(rawMap, luaLine);
  if (pos === null) {
    throw new Error(
      `assertLineMapsTo: Lua line ${luaLine} has no mapping in the external sourcemap`,
    );
  }
  if (pos.line !== expectedTsLine) {
    throw new Error(
      `assertLineMapsTo: Lua line ${luaLine} maps to TS line ${pos.line}, expected ${expectedTsLine}`,
    );
  }
}

/**
 * Assert that the `__TS__SourceMapTraceBack` table maps `luaLine` to `expectedTsLine`.
 *
 * Both line numbers are **1-based**.
 */
export function assertTracebackMapsTo(
  traceback: TracebackTable,
  luaLine: number,
  expectedTsLine: number,
): void {
  const actual = traceback[luaLine];
  if (actual === undefined) {
    throw new Error(
      `assertTracebackMapsTo: Lua line ${luaLine} has no entry in the traceback table`,
    );
  }
  if (actual !== expectedTsLine) {
    throw new Error(
      `assertTracebackMapsTo: Lua line ${luaLine} maps to TS line ${actual}, expected ${expectedTsLine}`,
    );
  }
}

/**
 * Return `true` if at least one mapping segment on `luaLine` has a valid
 * original-source position (`source` and `originalLine` both non-null).
 *
 * Use this instead of `mappingFor` for line-coverage checks: `mappingFor`
 * defaults to column 0 and may pass for a line whose only mapping comes from
 * a preceding indented statement, whereas `hasAnyMappingOnLine` iterates all
 * segments on the line and requires at least one with a real source reference.
 */
export async function hasAnyMappingOnLine(rawMap: string, luaLine: number): Promise<boolean> {
  return withConsumer(rawMap, (consumer) => {
    let found = false;
    consumer.eachMapping((m) => {
      if (!found && m.generatedLine === luaLine && m.source !== null && m.originalLine !== null) {
        found = true;
      }
    });
    return found;
  });
}

/**
 * Assert that `luaLine` (at `luaColumn`, default 0) has a mapping in the
 * external sourcemap and return the mapped position.
 *
 * Prefer this over `expect(pos).not.toBeNull(); expect(pos!.line).toBe(...)` to
 * avoid non-null assertions in test code.
 */
export async function assertMapped(
  rawMap: string,
  luaLine: number,
  luaColumn = 0,
): Promise<{ line: number; column: number; source: string }> {
  const pos = await mappingFor(rawMap, luaLine, luaColumn);
  if (pos === null) {
    throw new Error(
      `assertMapped: Lua line ${luaLine}, col ${luaColumn} has no mapping in the external sourcemap`,
    );
  }
  return pos;
}

/**
 * Assert that every non-empty Lua line in `range` (inclusive, 1-based) has at
 * least one mapping in the external sourcemap.
 *
 * **Range is required** — callers must scope the assertion to the plugin's
 * output region, not the whole file, to avoid false positives on TSTL boilerplate
 * lines (`local ____exports = {}`, `return ____exports`, etc.) that TSTL is
 * responsible for and that the plugin does not author.
 *
 * The optional `skip` predicate can filter out whitespace-only lines or known
 * TSTL scaffolding within the range.
 */
export async function assertEveryLineMapped(
  rawMap: string,
  lua: string,
  range: { start: number; end: number },
  options?: { skip?: (line: string, luaLineNumber: number) => boolean },
): Promise<void> {
  const lines = lua.split("\n");
  const unmapped: number[] = [];

  for (let lineNum = range.start; lineNum <= range.end; lineNum++) {
    const lineText = lines[lineNum - 1] ?? "";
    if (lineText.trim() === "") continue;
    if (options?.skip?.(lineText, lineNum)) continue;

    const hasMapped = await hasAnyMappingOnLine(rawMap, lineNum);
    if (!hasMapped) {
      unmapped.push(lineNum);
    }
  }

  if (unmapped.length > 0) {
    throw new Error(
      `assertEveryLineMapped: ${unmapped.length} Lua lines in [${range.start}..${range.end}] have no mapping: ${unmapped.join(", ")}`,
    );
  }
}

/**
 * Assert that every non-empty, non-skipped Lua line in `range` (inclusive,
 * 1-based) has a traceback entry pointing to `expectedTsLine`.
 *
 * Mirrors `assertEveryLineMapped` for the `__TS__SourceMapTraceBack` table.
 * Collects all mismatched lines before throwing so failures are reported in
 * aggregate rather than stopping at the first bad line.
 */
export function assertEveryTracebackLineMapsTo(
  traceback: TracebackTable,
  lua: string,
  range: { start: number; end: number },
  expectedTsLine: number,
  options?: { skip?: (line: string) => boolean },
): void {
  const lines = lua.split("\n");
  const failures: string[] = [];

  for (let lineNum = range.start; lineNum <= range.end; lineNum++) {
    const lineText = lines[lineNum - 1] ?? "";
    if (lineText.trim() === "") continue;
    if (options?.skip?.(lineText)) continue;

    const actual = traceback[lineNum];
    if (actual === undefined) {
      failures.push(`line ${lineNum}: no traceback entry`);
    } else if (actual !== expectedTsLine) {
      failures.push(`line ${lineNum}: maps to TS line ${actual}, expected ${expectedTsLine}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `assertEveryTracebackLineMapsTo: ${failures.length} failures in [${range.start}..${range.end}]:\n${failures.join("\n")}`,
    );
  }
}

/** Return the Lua column where the RHS expression begins on a simple `a = <expr>` line. */
export function rhsStartCol(luaLineText: string): number {
  const idx = luaLineText.indexOf(" = ");
  if (idx === -1) throw new Error(`No " = " on line: ${luaLineText}`);
  return idx + 3;
}
