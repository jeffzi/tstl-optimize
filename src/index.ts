import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isRuleEnabled, type PluginConfig, parseConfig, type RuleFactory } from "./config";
import { createVisitors as conditionalCompilationVisitors } from "./rules/conditional-compilation";
import { createVisitors as constantFoldingVisitors } from "./rules/constant-folding";
import { createVisitors as deadLocalVisitors } from "./rules/dead-local";
import { createVisitors as debugStripVisitors } from "./rules/debug-strip";
import { createVisitors as inlineVisitors } from "./rules/inline";
import { createVisitors as localizerVisitors } from "./rules/localizer";
import { createVisitors as loopRebaseVisitors } from "./rules/loop-rebase";
import { createVisitors as mathIntrinsicsVisitors } from "./rules/math-intrinsics";
import { createVisitors as mergeLocalsVisitors } from "./rules/merge-locals";
import { createVisitors as removeEmptyBranchVisitors } from "./rules/remove-empty-branch";

// Phase-based rule ordering. Phases execute in order; within each phase,
// rules execute in the order listed. This ensures critical dependencies:
// - fold runs first to collapse constants and strip dead branches from conditionals
// - eliminate (dead-local, merge-locals) runs before cleanup (remove-empty-branch)
//   so empty blocks are properly cleaned after local elimination
// - remaining phases follow: rebase, hoist, emit-prep
const PHASE_ENTRIES: [string, [keyof PluginConfig["rules"], RuleFactory][]][] = [
  [
    "fold",
    [
      ["conditional-compilation", conditionalCompilationVisitors],
      ["constant-folding", constantFoldingVisitors],
      ["math-intrinsics", mathIntrinsicsVisitors],
    ],
  ],
  [
    "eliminate",
    [
      ["dead-local", deadLocalVisitors],
      ["merge-locals", mergeLocalsVisitors],
    ],
  ],
  ["cleanup", [["remove-empty-branch", removeEmptyBranchVisitors]]],
  ["rebase", [["loop-rebase", loopRebaseVisitors]]],
  ["hoist", [["localizer", localizerVisitors]]],
  [
    "emit-prep",
    [
      ["inline", inlineVisitors],
      ["debug-strip", debugStripVisitors],
    ],
  ],
];

// Expression SyntaxKinds registered by our rules. When multiple rules share
// an expression kind, the merge wrapper needs a superTransformExpression
// fallback for the case where all chained visitors return undefined.
const EXPRESSION_KINDS: ReadonlySet<number> = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CallExpression,
]);

// Statement SyntaxKinds where returning undefined should fall through to
// TSTL's default transform instead of erasing the statement. Without this,
// a visitor returning undefined (meaning "not handled") for ExpressionStatement
// would silently erase it — unlike expression kinds which have the
// superTransformExpression fallback, and unlike conditional-compilation's
// statement kinds where erasure is the intended semantics.
const STATEMENT_KINDS_WITH_FALLBACK: ReadonlySet<number> = new Set([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.FunctionDeclaration,
]);

class OptimizePlugin implements tstl.Plugin {
  private checker!: ts.TypeChecker;
  private config: PluginConfig;
  private readonly explicitTarget: PluginConfig["target"];
  visitors: tstl.Visitors = {};

  constructor(options?: Record<string, unknown>) {
    this.config = parseConfig(options);
    this.explicitTarget = this.config.target;
  }

  beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
    this.checker = program.getTypeChecker();
    if (!this.explicitTarget) {
      this.config.target = options.luaTarget === tstl.LuaTarget.LuaJIT ? "luajit" : "puc";
    }
    this.buildVisitors();
  }

  private buildVisitors(): void {
    type AnyVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
    type ObjectVisitor = { priority?: number; transform: AnyVisitor };
    type MergedVisitor = AnyVisitor | ObjectVisitor;
    const merged: Record<number, MergedVisitor> = {};

    const unwrapVisitor = (visitor: MergedVisitor | undefined): ObjectVisitor | undefined => {
      if (visitor === undefined) {
        return undefined;
      }
      return typeof visitor === "function" ? { transform: visitor } : visitor;
    };

    // Flatten phases in order
    for (const [, phaseRules] of PHASE_ENTRIES) {
      for (const [ruleName, factory] of phaseRules) {
        if (!isRuleEnabled(this.config.rules, ruleName)) continue;

        const ruleVisitors = factory(this.checker, this.config);
        for (const [kindStr, rawVisitor] of Object.entries(ruleVisitors)) {
          const kind = Number(kindStr);
          const visitor = unwrapVisitor(rawVisitor as MergedVisitor);
          if (visitor === undefined) {
            continue;
          }

          const existing = unwrapVisitor(merged[kind]);
          const isExpr = EXPRESSION_KINDS.has(kind);
          const isStmtFallback = STATEMENT_KINDS_WITH_FALLBACK.has(kind);

          // Use max priority if both visitors have one, otherwise use whichever exists
          const mergedPriority =
            existing?.priority !== undefined && visitor.priority !== undefined
              ? Math.max(existing.priority, visitor.priority)
              : (existing?.priority ?? visitor.priority);

          const composed: AnyVisitor = (node, context) => {
            if (kind === ts.SyntaxKind.SourceFile) {
              const mockedContext = Object.create(context);
              mockedContext.superTransformNode = (n: ts.Node) => {
                if (existing) {
                  const existingRes = existing.transform(n, context);
                  return Array.isArray(existingRes) ? existingRes : [existingRes];
                }
                return context.superTransformNode(n);
              };
              mockedContext.superTransformStatements = (n: ts.Statement) => {
                return context.superTransformStatements(n);
              };
              return visitor.transform(node, mockedContext);
            }

            const res = visitor.transform(node, context) ?? existing?.transform(node, context);
            if (res !== undefined) return res;

            if (isExpr) return context.superTransformExpression(node as ts.Expression);
            if (isStmtFallback) return context.superTransformStatements(node as ts.Statement);
            return undefined;
          };

          merged[kind] =
            mergedPriority === undefined
              ? composed
              : {
                  priority: mergedPriority,
                  transform: composed,
                };
        }
      }
    }

    this.visitors = merged;
  }

  // Strip JSDoc artifact — TSTL converts all JSDoc tags to Lua comments,
  // but @inline is a compiler directive, not documentation
  beforeEmit(
    _program: ts.Program,
    _options: tstl.CompilerOptions,
    _emitHost: tstl.EmitHost,
    result: tstl.EmitFile[],
  ): void {
    if (!isRuleEnabled(this.config.rules, "inline")) return;
    for (const file of result) {
      file.code = file.code.replace(/(?:---\s*\n)?--\s*@inline\s*\n/g, "");
    }
  }
}

// TSTL calls `typeof factory === "function" ? factory(pluginOption) : factory`
// so the default export must be a function to receive tsconfig.json options.
export default (options?: Record<string, unknown>): OptimizePlugin => new OptimizePlugin(options);

export { OptimizePlugin };
