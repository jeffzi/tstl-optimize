import type luaparse from "luaparse";

export interface Edit {
  offset: number;
  length: number;
  replacement: string;
}

export function walkAstNode(node: luaparse.Node, onNode: (n: luaparse.Node) => void): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }

  onNode(node);

  for (const key in node as unknown as Record<string, unknown>) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAstNode(item as luaparse.Node, onNode);
      }
    } else if (value && typeof value === "object") {
      walkAstNode(value as luaparse.Node, onNode);
    }
  }
}

/**
 * luaparse emits `range` when `options.range = true`, but the type
 * declarations don't include it. This accessor avoids triple-cast noise
 * (`as unknown as { range: … }`) at every call site.
 */
export function nodeRange(node: luaparse.Node): [start: number, end: number] {
  return (node as unknown as { range: [number, number] }).range;
}

export function nextLineOffset(source: string, rangeEnd: number): number {
  const nl = source.indexOf("\n", rangeEnd);
  return nl === -1 ? source.length : nl + 1;
}

export function applyEdits(source: string, edits: Edit[]): string {
  edits.sort((a, b) => b.offset - a.offset);
  let result = source;
  for (const { offset, length, replacement } of edits) {
    result = result.slice(0, offset) + replacement + result.slice(offset + length);
  }
  return result;
}
