// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
//
// Parses a bash command with `unbash` and rewrites every `grep`/`find` command
// whose rule produces a faithful translation. The rewrite is a positional
// splice over the command name and its arguments, so redirects, pipelines,
// `&&`/`||` chains, prefixes and comments outside that span are preserved
// byte-for-byte.
//
// Safety rules:
//   * a command whose words contain a command/process substitution is skipped
//     (its inner script is not walked either);
//   * a command with a redirect interleaved between its name and its last
//     argument is skipped, because the splice span would swallow it;
//   * a rule that refuses is left untouched and recorded, never applied.
//
// The engine is pure: callers pass the enabled rules and the resolved binary
// names, which keeps it independent of `PATH` and process state.

import { parse } from "unbash";
import type { Command, Word } from "unbash";

import { joinTokens } from "./shell.ts";
import type { CommandRule, RuleId } from "./rules.ts";

export interface EnabledRule {
  readonly rule: CommandRule;
  /** Command name to emit (`rg`, `fd`, or the Debian alias `fdfind`). */
  readonly binary: string;
}

export interface AppliedChange {
  readonly rule: RuleId;
  readonly before: string;
  readonly after: string;
  readonly notes: readonly string[];
}

export interface RefusedChange {
  readonly rule: RuleId;
  readonly before: string;
  readonly reason: string;
}

export interface EngineResult {
  readonly command: string;
  readonly changes: readonly AppliedChange[];
  readonly refusals: readonly RefusedChange[];
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Collect every `Command` node without descending into word expansions. */
function collectCommands(node: unknown, out: Command[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCommands(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "Command") {
    out.push(record as unknown as Command);
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    // `parts` is a Word's expansion list; `script`/`inner` belong to nested
    // command substitutions, which we deliberately do not rewrite.
    if (key === "parts" || key === "script" || key === "inner" || key === "innerStart") continue;
    collectCommands(value, out);
  }
}

function hasSubstitution(word: Word | undefined): boolean {
  if (!word || !word.parts) return false;
  return word.parts.some(
    (part) => part.type === "CommandExpansion" || part.type === "ProcessSubstitution",
  );
}

/**
 * Rewrite `source`, applying the given rules. Rules are tried by command name;
 * the first rule whose `command` matches wins.
 */
export function rewriteCommand(source: string, enabled: readonly EnabledRule[]): EngineResult {
  if (enabled.length === 0) return { command: source, changes: [], refusals: [] };

  let script: unknown;
  try {
    script = parse(source);
  } catch {
    return { command: source, changes: [], refusals: [] };
  }

  const byName = new Map<string, EnabledRule>();
  for (const entry of enabled) {
    if (!byName.has(entry.rule.command)) byName.set(entry.rule.command, entry);
  }

  const commands: Command[] = [];
  collectCommands(script, commands);

  const replacements: Replacement[] = [];
  const changes: AppliedChange[] = [];
  const refusals: RefusedChange[] = [];

  for (const command of commands) {
    const name = command.name;
    if (!name || typeof name.value !== "string") continue;
    const entry = byName.get(name.value);
    if (!entry) continue;

    const spanStart = name.pos;
    let spanEnd = name.end;
    for (const word of command.suffix) {
      if (word.end > spanEnd) spanEnd = word.end;
    }
    if (spanEnd <= spanStart) continue;

    const words = [name, ...command.suffix];
    if (words.some(hasSubstitution)) continue;

    // A redirect inside the name..args span would be swallowed by the splice.
    const interleaved = command.redirects.some((r) => r.pos >= spanStart && r.pos < spanEnd);
    if (interleaved) continue;

    const before = source.slice(spanStart, spanEnd);
    const args = command.suffix.map((word) => ({ text: word.text, value: word.value }));

    let decision;
    try {
      decision = entry.rule.translate(args);
    } catch {
      continue;
    }

    if (decision.kind === "rewrite") {
      const text = decision.args.length > 0 ? `${entry.binary} ${joinTokens(decision.args)}` : entry.binary;
      replacements.push({ start: spanStart, end: spanEnd, text });
      changes.push({ rule: entry.rule.id, before, after: text, notes: decision.notes });
    } else if (decision.kind === "refuse") {
      refusals.push({ rule: entry.rule.id, before, reason: decision.reason });
    }
  }

  if (replacements.length === 0) return { command: source, changes, refusals };

  // Apply back-to-front so earlier offsets stay valid.
  replacements.sort((a, b) => b.start - a.start);
  let rewritten = source;
  for (const replacement of replacements) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }

  return { command: rewritten, changes, refusals };
}