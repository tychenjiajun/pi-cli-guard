// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------
//
// A rule is a pure translator: it receives the argument tokens of a command
// (after the command name) and returns either a rewritten command or a refusal
// with a reason. Refusing is always safe — the engine leaves the original text
// untouched.
//
// The registry is deliberately closed and curated. `pi-cli-guard` is not a
// general "swap any legacy tool" framework; it owns a small, tested set of
// modern-toolchain canonicalizations.

import type { ArgToken } from "./shell.ts";
import { token } from "./shell.ts";
import { translateGrep } from "./rules/grep.ts";
import { translateFind } from "./rules/find.ts";

/** Identifier of a built-in rule. */
export type RuleId = "grep-to-rg" | "egrep-to-rg" | "fgrep-to-rg" | "find-to-fd";

export type RuleDecision =
  | {
      kind: "rewrite";
      /** Replacement command name (e.g. `rg`). */
      name: string;
      /** Replacement argument tokens, already shell-safe. */
      args: ArgToken[];
      /** Human-readable notes about what changed (for the model notice). */
      notes: string[];
    }
  | { kind: "noop" }
  | { kind: "refuse"; reason: string };

export interface CommandRule {
  readonly id: RuleId;
  /** Legacy command name this rule matches (`grep`). */
  readonly command: string;
  /** Modern binary the rule rewrites to (`rg`), used for capability checks. */
  readonly binary: string;
  /** Alternative names the binary may have on PATH (e.g. `fdfind`). */
  readonly binaryAliases?: readonly string[];
  /** Short preference line for the model, e.g. `grep → rg (ripgrep)`. */
  readonly label: string;
  readonly translate: (args: readonly ArgToken[]) => RuleDecision;
}

/** Every rule ships enabled by default, in application order. */
export const RULE_IDS: readonly RuleId[] = [
  "grep-to-rg",
  "egrep-to-rg",
  "fgrep-to-rg",
  "find-to-fd",
];

/** The curated registry, keyed by id. */
export const RULES: Record<RuleId, CommandRule> = {
  "grep-to-rg": {
    id: "grep-to-rg",
    command: "grep",
    binary: "rg",
    label: "grep → rg (ripgrep)",
    translate: translateGrep,
  },
  // `egrep`/`fgrep` are grep with an implicit dialect: ERE and fixed strings.
  // Wrapping `translateGrep` with a synthetic leading flag reuses every option
  // mapping and the dialect gate below; the flag is dropped in the output
  // because rg is ERE-by-default and `-F` is passed through.
  "egrep-to-rg": {
    id: "egrep-to-rg",
    command: "egrep",
    binary: "rg",
    label: "egrep → rg (ripgrep)",
    translate: (args) => translateGrep([token("-E"), ...args]),
  },
  "fgrep-to-rg": {
    id: "fgrep-to-rg",
    command: "fgrep",
    binary: "rg",
    label: "fgrep → rg (ripgrep)",
    translate: (args) => translateGrep([token("-F"), ...args]),
  },
  "find-to-fd": {
    id: "find-to-fd",
    command: "find",
    binary: "fd",
    binaryAliases: ["fdfind"],
    label: "find → fd",
    translate: translateFind,
  },
};

/** Rules in application order. */
export const RULE_LIST: readonly CommandRule[] = RULE_IDS.map((id) => RULES[id]);

/** Parse a comma-separated rule list from configuration; unknown ids ignored. */
export function parseRuleIds(value: string | undefined): Set<RuleId> {
  if (value === undefined) return new Set(RULE_IDS);
  const wanted = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  return new Set(
    RULE_IDS.filter((id) => {
      const [source, target] = id.split("-to-");
      return wanted.has(id) || wanted.has(source!) || wanted.has(target!);
    }),
  );
}