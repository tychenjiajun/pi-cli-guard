// ---------------------------------------------------------------------------
// pi-cli-guard
// ---------------------------------------------------------------------------
//
// The model reaches for legacy CLI tools (`grep`, `find`) far more often than
// the modern replacements pi itself already ships (`rg`, `fd`) — the system
// prompt recommending `rg` is not enough (measured: thousands of `grep` calls
// vs a handful of `rg` across real sessions).
//
// This extension rewrites the model's bash command in the `tool_call` event:
// `grep` -> `rg`, and a conservative `find` -> `fd` subset. It deliberately
// does NOT override the bash tool, because pi's tool registry is "first
// registration per name wins" — a second `registerTool("bash")` would silently
// disable `pi-tool-guard`'s override. Mutating `event.input.command` composes
// with it instead.
//
// Rules are conservative: when a faithful translation is not obvious the
// original command is left untouched (see `rules/`). A short note is appended
// to the result so the model learns the preference.

import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { resolveConfig, type CliGuardConfig } from "./config.ts";
import {
  PI_CLI_GUARD_CONTRACT_VERSION,
  PI_CLI_GUARD_DETAILS_KEY,
  type PiCliGuardDetails,
} from "./contract.ts";
import { rewriteCommand } from "./engine.ts";
import { appendNotice, buildNoticeText, showStatus, statusText } from "./notice.ts";

/**
 * Upper bound on pending rewrite records. Records are deleted on `tool_result`;
 * an abandoned call (abort/crash between call and result) would otherwise leak
 * for the whole session. FIFO-bounded, like pi-codemode-guard.
 */
const MAX_PENDING_RECORDS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function remember(store: Map<string, PiCliGuardDetails>, id: string, value: PiCliGuardDetails): void {
  store.set(id, value);
  while (store.size > MAX_PENDING_RECORDS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Register the guard on `pi`. `config` is injectable for tests; in production
 * it is resolved from the environment on first use.
 */
export function registerCliGuard(pi: ExtensionAPI, config?: CliGuardConfig): void {
  let resolved = config;
  const getConfig = (): CliGuardConfig => (resolved ??= resolveConfig());
  const pending = new Map<string, PiCliGuardDetails>();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const cfg = getConfig();
    if (cfg.enabled.length === 0) return;

    const original = event.input.command;
    if (typeof original !== "string" || original.length === 0) return;

    let rewritten;
    try {
      rewritten = rewriteCommand(original, cfg.enabled);
    } catch {
      // A guard bug must never block the tool.
      return;
    }
    if (rewritten.changes.length === 0) return;

    const details: PiCliGuardDetails = {
      version: PI_CLI_GUARD_CONTRACT_VERSION,
      originalCommand: original,
      command: rewritten.command,
      changes: rewritten.changes.map((change) => ({
        rule: change.rule,
        before: change.before,
        after: change.after,
      })),
    };

    remember(pending, event.toolCallId, details);
    event.input.command = rewritten.command;

    try {
      const summary = statusText(details);
      showStatus(ctx, summary);
      if (ctx.hasUI) ctx.ui.notify(`pi-cli-guard: rewrote to ${summary.replace(/^.*· /, "")}`, "info");
    } catch {
      // The rewrite already happened; a UI failure must not block the tool.
    }
  });

  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;
    const details = pending.get(event.toolCallId);
    if (!details) return;
    pending.delete(event.toolCallId);

    const cfg = getConfig();
    const result: ToolResultEventResult = {
      details: {
        ...(isRecord(event.details) ? event.details : {}),
        [PI_CLI_GUARD_DETAILS_KEY]: details,
      },
    };
    if (cfg.notice) result.content = appendNotice(event.content, buildNoticeText(details));
    if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
    return result;
  });
}

export default function cliGuardExtension(pi: ExtensionAPI): void {
  registerCliGuard(pi);
}