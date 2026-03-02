import type ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isRuleEnabled, type PluginConfig, parseConfig, type RuleFactory } from "./config";
import { createVisitors as debugStripVisitors } from "./rules/debug-strip";
import { createVisitors as inlineVisitors } from "./rules/inline";
import { createVisitors as localizerVisitors } from "./rules/localizer";
import { createVisitors as loopRebaseVisitors } from "./rules/loop-rebase";
import { createVisitors as mathIntrinsicsVisitors } from "./rules/math-intrinsics";

// Registration order — last entry wins when two rules share a SyntaxKind
const RULE_ENTRIES: [keyof PluginConfig["rules"], RuleFactory][] = [
  ["math-intrinsics", mathIntrinsicsVisitors],
  ["loop-rebase", loopRebaseVisitors],
  ["inline", inlineVisitors],
  ["localizer", localizerVisitors],
  ["debug-strip", debugStripVisitors],
];

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
          merged[kind] = (node, context) => {
            const fnResult = fn(node, context);
            if (fnResult !== undefined) return fnResult;
            return existing(node, context);
          };
        } else {
          merged[kind] = fn;
        }
      }
    }

    // Safe: each key was originally from a well-typed Visitors object
    this.visitors = merged as unknown as tstl.Visitors;
  }

  // Strip @inline JSDoc artifacts — TSTL converts all JSDoc tags to Lua comments,
  // but @inline is a compiler directive consumed by the inline rule, not documentation
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
