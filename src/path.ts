// ---------------------------------------------------------------------------
// Executable lookup
// ---------------------------------------------------------------------------
//
// The guard only rewrites `grep`/`find` to `rg`/`fd` when the replacement
// binary is actually reachable, otherwise the rewritten command would fail.
// This scans `PATH` directly instead of spawning `which`, which keeps the check
// synchronous, dependency-free and trivially testable.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ExecutableLookup {
  /** Candidate binary names, in priority order (`fd`, then `fdfind`). */
  readonly names: readonly string[];
  readonly pathEnv: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Injectable predicates for tests. */
  readonly isFile?: (path: string) => boolean;
  readonly isExecutable?: (path: string) => boolean;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const fromEnv = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  return [".exe", ...fromEnv.map((e) => e.toLowerCase())].filter(
    (ext, index, all) => ext.length > 0 && all.indexOf(ext) === index,
  );
}

/** First candidate name that resolves to an executable file on `PATH`, or undefined. */
export function findExecutable(lookup: ExecutableLookup): string | undefined {
  const platform = lookup.platform ?? process.platform;
  const pathEnv = lookup.pathEnv ?? process.env.PATH ?? "";
  const isFile = lookup.isFile ?? defaultIsFile;
  const isExecutable = lookup.isExecutable ?? defaultIsExecutable;
  const extensions = executableExtensions(platform);

  for (const name of lookup.names) {
    // An absolute or relative path is used verbatim.
    if (name.includes("/") || name.includes("\\")) {
      if (isExecutable(name)) return name;
      continue;
    }
    for (const dir of pathEnv.split(delimiter)) {
      if (dir.length === 0) continue;
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        if (isFile(candidate) && isExecutable(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Resolve a rule's binary (with its aliases) against `PATH`.
 * Returns the command name to emit (canonical name when found under an alias)
 * or undefined when the tool is not installed.
 */
export function resolveBinary(
  rule: { readonly binary: string; readonly binaryAliases?: readonly string[] },
  env: { readonly pathEnv?: string; readonly platform?: NodeJS.Platform } = {},
): string | undefined {
  const names = [rule.binary, ...(rule.binaryAliases ?? [])];
  const found = findExecutable({
    names,
    pathEnv: env.pathEnv,
    platform: env.platform,
  });
  if (!found) return undefined;
  // Emit the canonical name when the binary is on PATH under any alias; the
  // alias only exists because some distros package it that way.
  // (`fd` is `fdfind` on Debian/Ubuntu.) If only the alias exists, emit it.
  const base = found.split(/[/\\]/).pop() ?? found;
  const canonicalHit =
    base === rule.binary ||
    base === `${rule.binary}.exe` ||
    base === `${rule.binary}.cmd`;
  return canonicalHit ? rule.binary : base;
}

export { isAbsolute };