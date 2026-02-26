import type ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isRuleEnabled, type PluginConfig, parseConfig, type RuleFactory } from "./config";
import { createVisitors as inlineVisitors } from "./rules/inline";
import { createVisitors as localizerVisitors } from "./rules/localizer";
import { createVisitors as loopRebaseVisitors } from "./rules/loop-rebase";
import { createVisitors as mathIntrinsicsVisitors } from "./rules/math-intrinsics";

// Ordered: math-intrinsics → loop-rebase → inline → localizer
const RULE_ENTRIES: [keyof PluginConfig["rules"], RuleFactory][] = [
  ["math-intrinsics", mathIntrinsicsVisitors],
  ["loop-rebase", loopRebaseVisitors],
  ["inline", inlineVisitors],
  ["localizer", localizerVisitors],
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
            const result = existing(node, context);
            if (result === undefined) return undefined;
            return fn(node, context);
          };
        } else {
          merged[kind] = fn;
        }
      }
    }

    // Safe: each key was originally from a well-typed Visitors object
    this.visitors = merged as unknown as tstl.Visitors;
  }
}

// Default export for tsconfig.json luaPlugins usage
const plugin = new OptimizePlugin();
export default plugin;

// Named export for in-memory test usage
export { OptimizePlugin };
