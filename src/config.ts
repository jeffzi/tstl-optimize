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

export type ConditionalCompilationRuleConfig = boolean | Partial<ConditionalCompilationConfig>;
export type LocalizerRuleConfig = boolean | Partial<LocalizerConfig>;
export type DebugStripRuleConfig = boolean | Partial<DebugStripConfig>;

export interface RulesConfig {
  "conditional-compilation": ConditionalCompilationRuleConfig;
  "constant-folding": boolean;
  "remove-empty-branch": boolean;
  "math-intrinsics": boolean;
  "loop-rebase": boolean;
  inline: boolean | InlineConfig;
  "dead-local": boolean;
  "merge-locals": boolean;
  localizer: LocalizerRuleConfig;
  "debug-strip": DebugStripRuleConfig;
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
  "constant-folding": true,
  "remove-empty-branch": true,
  "math-intrinsics": true,
  "loop-rebase": true,
  inline: true,
  "dead-local": true,
  "merge-locals": true,
  localizer: true,
  "debug-strip": false,
};

function resolveStructuredRuleConfig<T extends { enabled: boolean }>(
  value: boolean | Partial<T> | undefined,
  defaults: T,
): T | false {
  if (value === false) return false;
  if (value === undefined || value === true) return { ...defaults };
  return Object.assign(
    { ...defaults },
    Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)),
  );
}

function coerceStringArray(value: unknown, defaults: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return [...defaults];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function resolveDebugStripConfig(
  value: DebugStripRuleConfig | undefined,
): DebugStripConfig | false {
  const resolved = resolveStructuredRuleConfig(value, DEFAULT_DEBUG_STRIP);
  if (resolved === false) {
    return false;
  }

  return {
    ...resolved,
    enabled: resolved.enabled !== false,
    functions: coerceStringArray(resolved.functions, DEFAULT_DEBUG_STRIP.functions),
    namespaces: coerceStringArray(resolved.namespaces, DEFAULT_DEBUG_STRIP.namespaces),
  };
}

export function resolveLocalizerConfig(
  value: LocalizerRuleConfig | undefined,
): LocalizerConfig | false {
  const resolved = resolveStructuredRuleConfig(value, DEFAULT_LOCALIZER);
  if (resolved === false) {
    return false;
  }

  return {
    ...resolved,
    enabled: resolved.enabled !== false,
    threshold:
      typeof resolved.threshold === "number" && Number.isFinite(resolved.threshold)
        ? resolved.threshold
        : DEFAULT_LOCALIZER.threshold,
    scope: isLocalizerScope(resolved.scope) ? resolved.scope : DEFAULT_LOCALIZER.scope,
    include: coerceStringArray(resolved.include, DEFAULT_LOCALIZER.include),
    exclude: coerceStringArray(resolved.exclude, DEFAULT_LOCALIZER.exclude),
  };
}

function coerceEnvValue(envVal: string, defaultVal: ConstantValue): ConstantValue {
  if (typeof defaultVal === "boolean") {
    return envVal === "true" || envVal === "1";
  }
  if (typeof defaultVal === "number") {
    const num = Number.parseFloat(envVal);
    return Number.isFinite(num) ? num : defaultVal;
  }
  return envVal;
}

export function resolveConditionalCompilationConfig(
  value: ConditionalCompilationRuleConfig | undefined,
): ReadonlyMap<string, ConstantValue> | false {
  if (value === false || value === undefined) return false;

  if (value !== true && value.enabled === false) return false;

  const constants = value === true ? {} : coerceConstantDefs(value.constants);
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
  value: ConditionalCompilationRuleConfig | undefined,
): boolean | undefined {
  if (value === undefined || value === true || value === false) return undefined;
  return typeof value.strict === "boolean" ? value.strict : undefined;
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

function isLocalizerScope(val: unknown): val is LocalizerScope {
  return val === "module" || val === "function" || val === "all";
}

function isConstantValue(val: unknown): val is ConstantValue {
  return typeof val === "boolean" || typeof val === "number" || typeof val === "string";
}

function isConstantDef(val: unknown): val is ConstantDef {
  return isRecord(val) && typeof val.env === "string" && isConstantValue(val.default);
}

function coerceConstantDefs(value: unknown): Record<string, ConstantDef> {
  if (!isRecord(value)) {
    return {};
  }

  const constants: Record<string, ConstantDef> = {};
  for (const [name, def] of Object.entries(value)) {
    if (isConstantDef(def)) {
      constants[name] = def;
    }
  }
  return constants;
}

function parseConditionalCompilationRuleConfig(
  value: unknown,
): ConditionalCompilationRuleConfig | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: Partial<ConditionalCompilationConfig> = {};
  if (typeof value.enabled === "boolean") {
    parsed.enabled = value.enabled;
  }
  if (typeof value.strict === "boolean") {
    parsed.strict = value.strict;
  }
  if (value.constants === undefined || isRecord(value.constants)) {
    parsed.constants = coerceConstantDefs(value.constants);
  }
  return parsed;
}

function parseInlineRuleConfig(value: unknown): boolean | InlineConfig | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: InlineConfig = {};
  if (typeof value.enabled === "boolean") {
    parsed.enabled = value.enabled;
  }
  if (typeof value.strict === "boolean") {
    parsed.strict = value.strict;
  }
  return parsed;
}

function parseLocalizerRuleConfig(value: unknown): LocalizerRuleConfig | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: Partial<LocalizerConfig> = {};
  if (typeof value.enabled === "boolean") {
    parsed.enabled = value.enabled;
  }
  if (typeof value.threshold === "number" && Number.isFinite(value.threshold)) {
    parsed.threshold = value.threshold;
  }
  if (isLocalizerScope(value.scope)) {
    parsed.scope = value.scope;
  }
  if (Array.isArray(value.include)) {
    parsed.include = coerceStringArray(value.include, []);
  }
  if (Array.isArray(value.exclude)) {
    parsed.exclude = coerceStringArray(value.exclude, []);
  }
  return parsed;
}

function parseDebugStripRuleConfig(value: unknown): DebugStripRuleConfig | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: Partial<DebugStripConfig> = {};
  if (typeof value.enabled === "boolean") {
    parsed.enabled = value.enabled;
  }
  if (Array.isArray(value.functions)) {
    parsed.functions = coerceStringArray(value.functions, []);
  }
  if (Array.isArray(value.namespaces)) {
    parsed.namespaces = coerceStringArray(value.namespaces, []);
  }
  return parsed;
}

export function parseConfig(options?: Record<string, unknown>): PluginConfig {
  const rawRules = isRecord(options?.rules) ? options.rules : {};
  const rules: RulesConfig = { ...DEFAULT_RULES };

  for (const key of Object.keys(DEFAULT_RULES) as (keyof RulesConfig)[]) {
    const val = rawRules[key];
    if (val === undefined) continue;

    switch (key) {
      case "conditional-compilation": {
        const parsed = parseConditionalCompilationRuleConfig(val);
        if (parsed !== undefined) {
          rules["conditional-compilation"] = parsed;
        }
        break;
      }
      case "inline": {
        const parsed = parseInlineRuleConfig(val);
        if (parsed !== undefined) {
          rules.inline = parsed;
        }
        break;
      }
      case "localizer": {
        const parsed = parseLocalizerRuleConfig(val);
        if (parsed !== undefined) {
          rules.localizer = parsed;
        }
        break;
      }
      case "debug-strip": {
        const parsed = parseDebugStripRuleConfig(val);
        if (parsed !== undefined) {
          rules["debug-strip"] = parsed;
        }
        break;
      }
      default:
        if (typeof val === "boolean") {
          rules[key] = val;
        }
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
