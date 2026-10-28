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
export const PI_CLI_GUARD_CONTRACT_VERSION = 2;

export interface PiCliGuardChange {
  readonly rule: RuleId;
  readonly before: string;
  readonly after: string;
  /**
   * What this specific rewrite changed for the model, in notice order. The
   * first entry is the rule tag (`grep→rg`); the rest are scope/format
   * caveats that apply *to this command* (which may differ from the rule's
   * usual behaviour, e.g. `--include` turning ripgrep's ignore rules off).
   */
  readonly notes: readonly string[];
}

export interface PiCliGuardDetails {
  readonly version: number;
  /** The command the model wrote. */
  readonly originalCommand: string;
  /** The command that actually ran. */
  readonly command: string;
  readonly changes: readonly PiCliGuardChange[];
  /** Legacy commands a rule saw but declined to rewrite, in the same edit. */
  readonly refusals?: readonly PiCliGuardRefusal[];
}

export interface PiCliGuardRefusal {
  readonly rule: RuleId;
  readonly before: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChange(value: unknown): value is PiCliGuardChange {
  return (
    isRecord(value) &&
    typeof value.rule === "string" &&
    typeof value.before === "string" &&
    typeof value.after === "string" &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === "string")
  );
}

function isRefusal(value: unknown): value is PiCliGuardRefusal {
  return (
    isRecord(value) &&
    typeof value.rule === "string" &&
    typeof value.before === "string" &&
    typeof value.reason === "string"
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
  if (value.refusals !== undefined && (!Array.isArray(value.refusals) || !value.refusals.every(isRefusal))) {
    return undefined;
  }
  return value as unknown as PiCliGuardDetails;
}
