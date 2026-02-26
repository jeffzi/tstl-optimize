// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/** Count occurrences of a property access chain in a Lua statement list. */
export function countPropertyAccess(statements: tstl.Statement[], chain: string): number {
  let count = 0;
  const visit = (node: tstl.Node): void => {
    if (tstl.isTableIndexExpression(node)) {
      const repr = luaPropertyChain(node);
      if (repr === chain) count++;
    }
    for (const child of Object.values(node)) {
      if (isLuaNode(child)) visit(child);
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isLuaNode(item)) visit(item);
        }
      }
    }
  };
  for (const stmt of statements) visit(stmt);
  return count;
}

/** Build a dotted chain string from a Lua TableIndexExpression. */
export function luaPropertyChain(node: tstl.TableIndexExpression): string | undefined {
  const parts: string[] = [];

  let current: tstl.Expression = node;
  while (tstl.isTableIndexExpression(current)) {
    if (tstl.isStringLiteral(current.index)) {
      parts.unshift(current.index.value);
    } else {
      return undefined; // non-string index — can't represent as dotted chain
    }
    current = current.table;
  }
  if (tstl.isIdentifier(current)) {
    parts.unshift(current.text);
    return parts.join(".");
  }
  return undefined;
}

function isLuaNode(value: unknown): value is tstl.Node {
  return typeof value === "object" && value !== null && "kind" in value;
}
