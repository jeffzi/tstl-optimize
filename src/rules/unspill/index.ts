import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import type { RuleFactory } from "../../config";
import { getTransformedFile } from "../source-file";
import { unspillStatements } from "./transform";

export const createVisitors: RuleFactory = (): tstl.Visitors => ({
  [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context): tstl.File => {
    const nodes = context.superTransformNode(node);
    const file = getTransformedFile(nodes);
    const cleaned = unspillStatements(file.statements);
    file.statements.splice(0, file.statements.length, ...cleaned);
    return file;
  },
});
