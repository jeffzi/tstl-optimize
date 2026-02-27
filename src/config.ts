import type ts from "typescript";
import type * as tstl from "typescript-to-lua";

export type LocalizerScope = "module" | "function" | "all";

export interface LocalizerConfig {
  enabled: boolean;
  threshold: number;
  scope: LocalizerScope;
}

export interface RulesConfig {
  "math-intrinsics": boolean;
  "loop-rebase": boolean;
  inline: boolean;
  localizer: boolean | LocalizerConfig;
}

export type InterpreterTarget = "puc" | "luajit";

export interface PluginConfig {
  rules: RulesConfig;
  target?: InterpreterTarget;
}

const DEFAULT_LOCALIZER: LocalizerConfig = {
  enabled: true,
  threshold: 2,
  scope: "all",
};

const DEFAULT_RULES: RulesConfig = {
  "math-intrinsics": true,
  "loop-rebase": true,
  inline: true,
  localizer: true,
};

export function resolveLocalizerConfig(
  value: boolean | LocalizerConfig | undefined,
): LocalizerConfig | false {
  if (value === false) return false;
  if (value === undefined || value === true) return { ...DEFAULT_LOCALIZER };
  return { ...DEFAULT_LOCALIZER, ...value };
}

export function isRuleEnabled(config: RulesConfig, rule: keyof RulesConfig): boolean {
  const value = config[rule];
  if (typeof value === "boolean") return value;
  return value.enabled !== false;
}

export type RuleFactory = (checker: ts.TypeChecker, config: PluginConfig) => tstl.Visitors;

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function parseConfig(options?: Record<string, unknown>): PluginConfig {
  const rawRules = isRecord(options?.rules) ? options.rules : {};

  const rules: RulesConfig = { ...DEFAULT_RULES };

  for (const key of Object.keys(DEFAULT_RULES) as (keyof RulesConfig)[]) {
    if (key in rawRules) {
      const val = rawRules[key];
      if (key === "localizer") {
        if (typeof val === "boolean" || isRecord(val)) {
          // Safe after guard: val is boolean or a config object from tsconfig.json
          rules.localizer = val as boolean | LocalizerConfig;
        }
      } else if (typeof val === "boolean") {
        rules[key] = val;
      }
    }
  }

  const target = isInterpreterTarget(options?.target) ? options.target : undefined;

  return { rules, target };
}

const INTERPRETER_TARGETS: ReadonlySet<string> = new Set(["puc", "luajit"]);

function isInterpreterTarget(val: unknown): val is InterpreterTarget {
  return typeof val === "string" && INTERPRETER_TARGETS.has(val);
}
