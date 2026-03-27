import type ts from "typescript";
import type * as tstl from "typescript-to-lua";

export interface DebugStripConfig {
  enabled: boolean;
  functions: string[];
  namespaces: string[];
}

export type LocalizerScope = "module" | "function" | "all";

export interface LocalizerConfig {
  enabled: boolean;
  threshold: number;
  scope: LocalizerScope;
  include: string[];
  exclude: string[];
}

export type ConstantValue = boolean | number | string;

export interface ConstantDef {
  env: string;
  default: ConstantValue;
}

export interface ConditionalCompilationConfig {
  enabled: boolean;
  constants: Record<string, ConstantDef>;
}

export interface RulesConfig {
  "conditional-compilation": boolean | ConditionalCompilationConfig;
  "math-intrinsics": boolean;
  "loop-rebase": boolean;
  inline: boolean;
  localizer: boolean | LocalizerConfig;
  "debug-strip": boolean | DebugStripConfig;
}

export type InterpreterTarget = "puc" | "luajit";

export interface PluginConfig {
  rules: RulesConfig;
  target?: InterpreterTarget;
}

const DEFAULT_DEBUG_STRIP: DebugStripConfig = {
  enabled: true,
  functions: ["print", "assert"],
  namespaces: ["debug"],
};

const DEFAULT_LOCALIZER: LocalizerConfig = {
  enabled: true,
  threshold: 2,
  scope: "all",
  include: [],
  exclude: [],
};

const DEFAULT_RULES: RulesConfig = {
  "conditional-compilation": false,
  "math-intrinsics": true,
  "loop-rebase": true,
  inline: true,
  localizer: true,
  "debug-strip": false,
};

export function resolveDebugStripConfig(
  value: boolean | DebugStripConfig | undefined,
): DebugStripConfig | false {
  if (value === false) return false;
  if (value === undefined || value === true) return { ...DEFAULT_DEBUG_STRIP };
  return { ...DEFAULT_DEBUG_STRIP, ...value };
}

export function resolveLocalizerConfig(
  value: boolean | LocalizerConfig | undefined,
): LocalizerConfig | false {
  if (value === false) return false;
  if (value === undefined || value === true) return { ...DEFAULT_LOCALIZER };
  return { ...DEFAULT_LOCALIZER, ...value };
}

function coerceEnvValue(envVal: string, defaultVal: ConstantValue): ConstantValue {
  if (typeof defaultVal === "boolean") {
    return envVal === "true" || envVal === "1";
  }
  if (typeof defaultVal === "number") {
    const num = Number.parseFloat(envVal);
    return Number.isNaN(num) ? defaultVal : num;
  }
  return envVal;
}

export function resolveConditionalCompilationConfig(
  value: boolean | ConditionalCompilationConfig | undefined,
): ReadonlyMap<string, ConstantValue> | false {
  if (value === false || value === undefined) return false;

  const constants = value === true ? {} : value.constants;
  if (value !== true && value.enabled === false) return false;

  const resolved = new Map<string, ConstantValue>();
  for (const [name, def] of Object.entries(constants)) {
    const envVal = process.env[def.env];
    resolved.set(name, envVal === undefined ? def.default : coerceEnvValue(envVal, def.default));
  }
  return resolved;
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
      if (key === "conditional-compilation") {
        if (typeof val === "boolean" || isRecord(val)) {
          rules["conditional-compilation"] = val as boolean | ConditionalCompilationConfig;
        }
      } else if (key === "localizer") {
        if (typeof val === "boolean" || isRecord(val)) {
          // Safe after guard: val is boolean or a config object from tsconfig.json
          rules.localizer = val as boolean | LocalizerConfig;
        }
      } else if (key === "debug-strip") {
        if (typeof val === "boolean" || isRecord(val)) {
          rules["debug-strip"] = val as boolean | DebugStripConfig;
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
