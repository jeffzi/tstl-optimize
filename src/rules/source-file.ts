// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

const LUA_STATEMENT_KINDS: ReadonlySet<tstl.SyntaxKind> = new Set([
  tstl.SyntaxKind.DoStatement,
  tstl.SyntaxKind.VariableDeclarationStatement,
  tstl.SyntaxKind.AssignmentStatement,
  tstl.SyntaxKind.IfStatement,
  tstl.SyntaxKind.WhileStatement,
  tstl.SyntaxKind.RepeatStatement,
  tstl.SyntaxKind.ForStatement,
  tstl.SyntaxKind.ForInStatement,
  tstl.SyntaxKind.GotoStatement,
  tstl.SyntaxKind.LabelStatement,
  tstl.SyntaxKind.ReturnStatement,
  tstl.SyntaxKind.BreakStatement,
  tstl.SyntaxKind.ContinueStatement,
  tstl.SyntaxKind.ExpressionStatement,
]);

function isLuaNode(node: unknown): node is tstl.Node {
  return typeof node === "object" && node !== null && "kind" in node && "flags" in node;
}

function isLuaStatement(node: unknown): node is tstl.Statement {
  return isLuaNode(node) && LUA_STATEMENT_KINDS.has(node.kind);
}

function isLuaStatementArray(value: unknown): value is tstl.Statement[] {
  return Array.isArray(value) && value.every(isLuaStatement);
}

export function getTransformedFile(result: unknown): tstl.File {
  if (Array.isArray(result)) {
    const [file] = result;
    if (isLuaNode(file) && tstl.isFile(file)) {
      return file;
    }
    if (isLuaStatementArray(result)) {
      return tstl.createFile(result, new Set<tstl.LuaLibFeature>(), "");
    }
  } else if (isLuaNode(result) && tstl.isFile(result)) {
    return result;
  }

  throw new Error("expected SourceFile transform to produce a Lua file");
}
