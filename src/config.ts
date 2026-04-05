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
  strict?: boolean;
}

export interface InlineConfig {
  enabled?: boolean;
  strict?: boolean;
}

export interface RulesConfig {
  "conditional-compilation": boolean | ConditionalCompilationConfig;
  "constant-folding": boolean;
  "math-intrinsics": boolean;
  "loop-rebase": boolean;
  inline: boolean | InlineConfig;
  "dead-local": boolean;
  "merge-locals": boolean;
  localizer: boolean | LocalizerConfig;
  "debug-strip": boolean | DebugStripConfig;
}

export type InterpreterTarget = "puc" | "luajit";

export interface PluginConfig {
  rules: RulesConfig;
  target?: InterpreterTarget;
  strict?: boolean;
}

const DEFAULT_DEBUG_STRIP: DebugStripConfig = {
  enabled: true,
  functions: ["print", "assert"],
  namespaces: ["debug", "console"],
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
  "constant-folding": true,
  "math-intrinsics": true,
  "loop-rebase": true,
  inline: true,
  "dead-local": true,
  "merge-locals": true,
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

export function resolveInlineConfig(value: boolean | InlineConfig | undefined): {
  enabled: boolean;
  strict: boolean;
} {
  if (value === false) return { enabled: false, strict: false };
  if (value === undefined || value === true) return { enabled: true, strict: false };
  return {
    enabled: value.enabled !== false,
    strict: value.strict === true,
  };
}

/**
 * Extracts the per-rule strict field from ConditionalCompilationConfig.
 * Returns undefined when value is not an object (boolean or absent), meaning "not set".
 */
export function resolveConditionalCompilationStrict(
  value: boolean | ConditionalCompilationConfig | undefined,
): boolean | undefined {
  if (value === undefined || value === true || value === false) return undefined;
  return value.strict;
}

/**
 * Resolves the effective strict flag from global and per-rule overrides.
 * Per-rule `false` always wins over global `true` (allows opting a rule out of global strict).
 */
export function resolveEffectiveStrict(
  globalStrict: boolean,
  perRuleStrict: boolean | undefined,
): boolean {
  if (perRuleStrict === false) return false;
  return globalStrict || perRuleStrict === true;
}

export function isRuleEnabled(config: RulesConfig, rule: keyof RulesConfig): boolean {
  const value = config[rule];
  if (typeof value === "boolean") return value;
  return value.enabled !== false;
}

export type RuleFactory = (checker: ts.TypeChecker, config: PluginConfig) => tstl.Visitors;

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val != null && !Array.isArray(val);
}

const STRUCTURED_RULES: ReadonlySet<string> = new Set([
  "conditional-compilation",
  "inline",
  "localizer",
  "debug-strip",
]);

export function parseConfig(options?: Record<string, unknown>): PluginConfig {
  const rawRules = isRecord(options?.rules) ? options.rules : {};
  const rules: RulesConfig = { ...DEFAULT_RULES };

  for (const key of Object.keys(DEFAULT_RULES) as (keyof RulesConfig)[]) {
    const val = rawRules[key];
    if (val === undefined) continue;

    if (STRUCTURED_RULES.has(key)) {
      if (typeof val === "boolean" || isRecord(val)) {
        // RulesConfig has no index signature, so dynamic write requires the double
        // widen through unknown — val is already guarded to the correct union member.
        (rules as unknown as Record<string, unknown>)[key] = val;
      }
    } else if (typeof val === "boolean") {
      rules[key] = val;
    }
  }

  return {
    rules,
    target: isInterpreterTarget(options?.target) ? options.target : undefined,
    strict: options?.strict === true,
  };
}

const INTERPRETER_TARGETS: ReadonlySet<string> = new Set(["puc", "luajit"]);

function isInterpreterTarget(val: unknown): val is InterpreterTarget {
  return typeof val === "string" && INTERPRETER_TARGETS.has(val);
}
