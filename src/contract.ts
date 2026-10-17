// ---------------------------------------------------------------------------
// Interop contract
// ---------------------------------------------------------------------------
//
// On a rewrite the guard stamps `details.piCliGuard` on the bash result so a
// renderer or downstream reducer can see exactly what was changed without
// re-parsing the notice text. Consumers must parse via `readPiCliGuardDetails`
// and fall back to the original command for unknown versions.

import type { RuleId } from "./rules.ts";

export const PI_CLI_GUARD_DETAILS_KEY = "piCliGuard";
export const PI_CLI_GUARD_CONTRACT_VERSION = 1;

export interface PiCliGuardChange {
  readonly rule: RuleId;
  readonly before: string;
  readonly after: string;
}

export interface PiCliGuardDetails {
  readonly version: number;
  /** The command the model wrote. */
  readonly originalCommand: string;
  /** The command that actually ran. */
  readonly command: string;
  readonly changes: readonly PiCliGuardChange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChange(value: unknown): value is PiCliGuardChange {
  return (
    isRecord(value) &&
    typeof value.rule === "string" &&
    typeof value.before === "string" &&
    typeof value.after === "string"
  );
}

/** Read a well-formed `piCliGuard` record, or undefined for anything else. */
export function readPiCliGuardDetails(details: unknown): PiCliGuardDetails | undefined {
  if (!isRecord(details)) return undefined;
  const value = details[PI_CLI_GUARD_DETAILS_KEY];
  if (!isRecord(value)) return undefined;
  if (value.version !== PI_CLI_GUARD_CONTRACT_VERSION) return undefined;
  if (typeof value.originalCommand !== "string" || typeof value.command !== "string") return undefined;
  if (!Array.isArray(value.changes) || !value.changes.every(isChange)) return undefined;
  return value as unknown as PiCliGuardDetails;
}