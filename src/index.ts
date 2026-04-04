import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isRuleEnabled, type PluginConfig, parseConfig, type RuleFactory } from "./config";
import { createVisitors as conditionalCompilationVisitors } from "./rules/conditional-compilation";
import { createVisitors as constantFoldingVisitors } from "./rules/constant-folding";
import { createVisitors as debugStripVisitors } from "./rules/debug-strip";
import { createVisitors as inlineVisitors } from "./rules/inline";
import { createVisitors as deadLocalVisitors } from "./rules/dead-local";
import { createVisitors as localizerVisitors } from "./rules/localizer";
import { createVisitors as loopRebaseVisitors } from "./rules/loop-rebase";
import { createVisitors as mathIntrinsicsVisitors } from "./rules/math-intrinsics";

// Registration order — later entries have higher priority when two rules
// share a SyntaxKind. conditional-compilation is first (lowest priority)
// so dead branches are stripped before other rules process surviving code.
const RULE_ENTRIES: [keyof PluginConfig["rules"], RuleFactory][] = [
  ["conditional-compilation", conditionalCompilationVisitors],
  ["constant-folding", constantFoldingVisitors],
  ["math-intrinsics", mathIntrinsicsVisitors],
  ["loop-rebase", loopRebaseVisitors],
  ["inline", inlineVisitors],
  ["dead-local", deadLocalVisitors],
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
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.FunctionDeclaration,
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
    type AnyVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
    const merged: Record<number, AnyVisitor> = {};

    for (const [ruleName, factory] of RULE_ENTRIES) {
      if (!isRuleEnabled(this.config.rules, ruleName)) continue;

      const ruleVisitors = factory(this.checker, this.config);
      for (const [kindStr, rawVisitor] of Object.entries(ruleVisitors)) {
        const kind = Number(kindStr);
        const visitor = rawVisitor as AnyVisitor | { transform: AnyVisitor };
        const fn: AnyVisitor = typeof visitor === "function" ? visitor : visitor.transform;

        const existing = merged[kind];
        const isExpr = EXPRESSION_KINDS.has(kind);
        const isStmtFallback = STATEMENT_KINDS_WITH_FALLBACK.has(kind);

        merged[kind] = (node, context) => {
          if (kind === ts.SyntaxKind.SourceFile) {
            const mockedContext = Object.create(context);
            mockedContext.superTransformNode = (n: ts.Node) => {
              if (existing) {
                const existingRes = existing(n, context);
                return Array.isArray(existingRes) ? existingRes : [existingRes];
              }
              return context.superTransformNode(n);
            };
            mockedContext.superTransformStatements = (n: ts.Statement) => {
              if (existing) {
                const existingRes = existing(n, context);
                return Array.isArray(existingRes) ? existingRes : [existingRes];
              }
              return context.superTransformStatements(n);
            };
            return fn(node, mockedContext);
          }

          const res = fn(node, context) ?? existing?.(node, context);
          if (res !== undefined) return res;

          if (isExpr) return context.superTransformExpression(node as ts.Expression);
          if (isStmtFallback) return context.superTransformStatements(node as ts.Statement);
          return undefined;
        };
      }
    }

    for (const key of Object.keys(this.visitors)) {
      Reflect.deleteProperty(this.visitors, key);
    }
    Object.assign(this.visitors, merged);
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
      // Remove @inline from JSDoc comments in emitted Lua.
      file.code = file.code.replace(/(?:---\s*\n)?--\s*@inline\s*\n/g, "");
    }
  }
}

// TSTL calls `typeof factory === "function" ? factory(pluginOption) : factory`
// so the default export must be a function to receive tsconfig.json options.
export default (options?: Record<string, unknown>): OptimizePlugin => new OptimizePlugin(options);

export { OptimizePlugin };
