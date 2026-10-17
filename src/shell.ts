// ---------------------------------------------------------------------------
// Shell token helpers
// ---------------------------------------------------------------------------
//
// A `ArgToken` carries both the raw shell text of a word (what we splice back
// into the command, so quoting/expansions are preserved) and its parsed value
// (what the translator inspects to recognise flags and patterns).

export interface ArgToken {
  /** Raw shell text of the word, exactly as the parser saw it. */
  readonly text: string;
  /** Parsed value of the word (`"*.py"` -> `*.py`). */
  readonly value: string;
}

/** A synthesized token from a bare string; quoted only when it needs it. */
export function token(value: string): ArgToken {
  return { text: shellQuote(value), value };
}

/** A token from known-safe raw text whose value we already hold. */
export function rawToken(text: string, value: string): ArgToken {
  return { text, value };
}

// Conservative: only a bare word made of these characters is safe to leave
// unquoted. Globs, braces and `!` are intentionally quoted so bash never
// performs pathname/brace expansion on fd/rg patterns.
const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a single shell word so it survives a round trip through `sh`.
 * Conservative: everything that is not in a small safe set is single-quoted.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (SAFE_UNQUOTED.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Join tokens with single spaces (internal whitespace is normalized). */
export function joinTokens(tokens: readonly ArgToken[]): string {
  return tokens.map((t) => t.text).join(" ");
}