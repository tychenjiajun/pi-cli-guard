// ---------------------------------------------------------------------------
// Model notice + UI status
// ---------------------------------------------------------------------------
//
// Rewriting silently would leave the model unable to explain a changed result,
// so a one-line note is appended to the bash result (opt out with
// `PI_CLI_GUARD_NOTICE=off`). A transient footer status mirrors the change in
// the TUI.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PI_CLI_GUARD_DETAILS_KEY, type PiCliGuardDetails } from "./contract.ts";
import { RULES, type RuleId } from "./rules.ts";

const GUARD_GLYPH = "🛡";
const STATUS_KEY = "pi-cli-guard";
const STATUS_DURATION_MS = 4_000;
const statusTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

const GUIDANCE: Record<RuleId, string> = {
  "grep-to-rg": "rg respects .gitignore and skips hidden files (add -u to search all).",
  "find-to-fd": "fd skips hidden and .gitignore'd paths (add -u to search all).",
};

/** `grep → rg (ripgrep) · find → fd` for the rules that fired. */
export function summarizeRules(details: PiCliGuardDetails): string {
  const seen = new Set<RuleId>();
  const labels: string[] = [];
  for (const change of details.changes) {
    if (seen.has(change.rule)) continue;
    seen.add(change.rule);
    labels.push(RULES[change.rule].label);
  }
  return labels.join(" · ");
}

/** The line appended to the bash result so the model sees what changed. */
export function buildNoticeText(details: PiCliGuardDetails): string {
  const lines = ["[pi-cli-guard] Rewrote bash command(s) to the preferred modern toolchain:"];
  for (const change of details.changes) {
    lines.push(`  ${change.before}  →  ${change.after}`);
  }
  const guidance = new Set<RuleId>();
  for (const change of details.changes) guidance.add(change.rule);
  for (const rule of guidance) lines.push(GUIDANCE[rule]);
  return lines.join("\n");
}

/** Append the notice to a bash result's content, preserving text/image parts. */
export function appendNotice<T extends { type: string }>(content: readonly T[], text: string): (T | { type: "text"; text: string })[] {
  return [...content, { type: "text", text: `\n${text}` }];
}

/** Flash `🛡 pi-cli-guard · <summary>` in the footer and clear it a few seconds later. */
export function showStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui" || !ctx.ui) return;
  ctx.ui.setStatus(STATUS_KEY, text);

  const key: object = ctx.ui;
  const previous = statusTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    if (statusTimers.get(key) !== timer) return;
    statusTimers.delete(key);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }, STATUS_DURATION_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  statusTimers.set(key, timer);
}

export function statusText(details: PiCliGuardDetails): string {
  return `${GUARD_GLYPH} pi-cli-guard · ${summarizeRules(details)}`;
}

export { PI_CLI_GUARD_DETAILS_KEY };