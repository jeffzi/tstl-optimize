import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isRuleEnabled, type PluginConfig, parseConfig, type RuleFactory } from "./config";
import { createVisitors as conditionalCompilationVisitors } from "./rules/conditional-compilation";
import { createVisitors as debugStripVisitors } from "./rules/debug-strip";
import { createVisitors as inlineVisitors } from "./rules/inline";
import { createVisitors as localizerVisitors } from "./rules/localizer";
import { createVisitors as loopRebaseVisitors } from "./rules/loop-rebase";
import { createVisitors as mathIntrinsicsVisitors } from "./rules/math-intrinsics";

// Registration order — later entries have higher priority when two rules
// share a SyntaxKind. conditional-compilation is first (lowest priority)
// so dead branches are stripped before other rules process surviving code.
const RULE_ENTRIES: [keyof PluginConfig["rules"], RuleFactory][] = [
  ["conditional-compilation", conditionalCompilationVisitors],
  ["math-intrinsics", mathIntrinsicsVisitors],
  ["loop-rebase", loopRebaseVisitors],
  ["inline", inlineVisitors],
  ["localizer", localizerVisitors],
  ["debug-strip", debugStripVisitors],
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
]);

class OptimizePlugin implements tstl.Plugin {
  private checker!: ts.TypeChecker;
  private config: PluginConfig;
  visitors: tstl.Visitors = {};

  constructor(options?: Record<string, unknown>) {
    this.config = parseConfig(options);
  }

  beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
    this.checker = program.getTypeChecker();
    if (!this.config.target) {
      this.config.target = options.luaTarget === tstl.LuaTarget.LuaJIT ? "luajit" : "puc";
    }
    this.buildVisitors();
  }

  private buildVisitors(): void {
    // Dynamic merging requires loose typing — the Visitors mapped type
    // can't track kind↔node relationships through Object.entries iteration
    type AnyVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
    type LooseVisitors = Record<number, AnyVisitor>;
    const merged: LooseVisitors = {};

    for (const [ruleName, factory] of RULE_ENTRIES) {
      if (!isRuleEnabled(this.config.rules, ruleName)) continue;
      const ruleVisitors = factory(this.checker, this.config);
      for (const [kindStr, rawVisitor] of Object.entries(ruleVisitors)) {
        const kind = Number(kindStr);
        // Contravariance prevents direct assignment — safe because each
        // visitor only receives nodes matching its registered SyntaxKind
        const visitor = rawVisitor as AnyVisitor | { transform: AnyVisitor };
        const fn: AnyVisitor = typeof visitor === "function" ? visitor : visitor.transform;
        const existing = merged[kind];
        if (existing) {
          // Chain: higher-priority visitor (fn) runs first; returning
          // undefined signals "not handled" and falls through to the
          // lower-priority visitor (existing). If ALL visitors return
          // undefined, the wrapper calls TSTL's default transformation
          // for expression kinds; for statement kinds with fallback it
          // calls superTransformStatements; for other statement kinds
          // undefined means "erase" which is the intended semantics.
          const isExpr = EXPRESSION_KINDS.has(kind);
          const isStatementWithFallback = STATEMENT_KINDS_WITH_FALLBACK.has(kind);
          merged[kind] = (node, context) => {
            const fnResult = fn(node, context);
            if (fnResult !== undefined) return fnResult;
            const existingResult = existing(node, context);
            if (existingResult !== undefined) return existingResult;
            if (isExpr) return context.superTransformExpression(node as ts.Expression);
            if (isStatementWithFallback) {
              return context.superTransformStatements(node as ts.Statement);
            }
            return undefined;
          };
        } else if (EXPRESSION_KINDS.has(kind)) {
          merged[kind] = (node, context) => {
            const result = fn(node, context);
            if (result !== undefined) return result;
            return context.superTransformExpression(node as ts.Expression);
          };
        } else if (STATEMENT_KINDS_WITH_FALLBACK.has(kind)) {
          merged[kind] = (node, context) => {
            const result = fn(node, context);
            if (result !== undefined) return result;
            return context.superTransformStatements(node as ts.Statement);
          };
        } else {
          merged[kind] = fn;
        }
      }
    }

    // Safe: each key was originally from a well-typed Visitors object
    this.visitors = merged as unknown as tstl.Visitors;
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
      file.code = file.code.replace(/---\n-- @inline\n/g, "");
    }
  }
}

// TSTL calls `typeof factory === "function" ? factory(pluginOption) : factory`
// so the default export must be a function to receive tsconfig.json options.
export default (options?: Record<string, unknown>): OptimizePlugin => new OptimizePlugin(options);

// Named export for in-memory test usage
export { OptimizePlugin };
