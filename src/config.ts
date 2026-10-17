// ---------------------------------------------------------------------------
// Modern-toolchain rule resolution
// ---------------------------------------------------------------------------
//
// Configuration is read from the environment so the extension needs no settings
// plumbing:
//
//   PI_CLI_GUARD=off            disable the extension entirely
//   PI_CLI_GUARD_RULES=rg,fd    restrict which rules run (default: all)
//   PI_CLI_GUARD_NOTICE=off     do not append the rewrite note to the result
//
// A rule only runs when its replacement binary resolves on `PATH`; otherwise
// the model's `grep`/`find` is left untouched rather than rewritten to a
// command that would fail.

import { resolveBinary } from "./path.ts";
import type { EnabledRule } from "./engine.ts";
import { RULES, parseRuleIds, type RuleId } from "./rules.ts";

export interface CliGuardConfig {
  readonly enabled: readonly EnabledRule[];
  readonly notice: boolean;
}

function isOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "0" || normalized === "off" || normalized === "false";
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): CliGuardConfig {
  if (isOff(env.PI_CLI_GUARD)) return { enabled: [], notice: false };

  const wanted: Set<RuleId> = parseRuleIds(env.PI_CLI_GUARD_RULES);
  const enabled: EnabledRule[] = [];
  for (const id of wanted) {
    const rule = RULES[id];
    const binary = resolveBinary(rule, { pathEnv: env.PATH });
    if (binary) enabled.push({ rule, binary });
  }

  return { enabled, notice: !isOff(env.PI_CLI_GUARD_NOTICE) };
}