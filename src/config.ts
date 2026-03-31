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
  "math-intrinsics": boolean;
  "loop-rebase": boolean;
  inline: boolean | InlineConfig;
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
  // value is ConditionalCompilationConfig — object narrowing, no cast required
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
  // Per-rule false always wins over global true.
  if (perRuleStrict === false) return false;
  // Global true, or per-rule true, or both — strict is active.
  return globalStrict || perRuleStrict === true;
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
    if (!(key in rawRules)) continue;
    const val = rawRules[key];
    if (STRUCTURED_RULES.has(key)) {
      if (typeof val === "boolean" || isRecord(val)) {
        // Safe: val is boolean or a config object from tsconfig.json
        (rules as unknown as Record<string, unknown>)[key] = val;
      }
    } else if (typeof val === "boolean") {
      rules[key] = val;
    }
  }

  const target = isInterpreterTarget(options?.target) ? options.target : undefined;
  const strict = options?.strict === true;

  return { rules, target, strict };
}

const INTERPRETER_TARGETS: ReadonlySet<string> = new Set(["puc", "luajit"]);

function isInterpreterTarget(val: unknown): val is InterpreterTarget {
  return typeof val === "string" && INTERPRETER_TARGETS.has(val);
}
