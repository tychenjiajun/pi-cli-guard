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

/** How many before → after lines the model notice lists before summarizing. */
const MAX_LISTED_CHANGES = 3;

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
  const lines = [
    `[pi-cli-guard] Rewrote bash command(s) to the preferred modern toolchain: ${summarizeRules(details)}`,
  ];
  for (const change of details.changes.slice(0, MAX_LISTED_CHANGES)) {
    lines.push(`  ${change.before}  →  ${change.after}`);
  }
  const hidden = details.changes.length - MAX_LISTED_CHANGES;
  if (hidden > 0) lines.push(`  (+${hidden} more; see details.piCliGuard)`);

  // The rules already know what they changed for this command, so the notice is
  // driven by those notes rather than one paragraph per rule. Dedupe by text,
  // so a chain that rewrites both `grep` and `egrep` states a shared caveat once.
  const guidance = new Set<string>();
  // `notes[0]` is the rule tag (`grep→rg`); the rest are caveats for the model.
  for (const change of details.changes) {
    for (const note of change.notes.slice(1)) guidance.add(note);
  }
  for (const text of guidance) lines.push(text);

  const refused = details.refusals?.length ?? 0;
  if (refused > 0) {
    const plural = refused === 1 ? "" : "s";
    lines.push(
      `Left ${refused} other command${plural} unchanged (no faithful rewrite; see details.piCliGuard).`,
    );
  }
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
