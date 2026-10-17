// ---------------------------------------------------------------------------
// grep -> rg
// ---------------------------------------------------------------------------
//
// Translates a `grep` invocation into a faithful `rg` invocation, or refuses.
//
// Two things make a naive rename wrong:
//
//   1. Option letters collide with different meanings (`-h` is help in rg,
//      `-H` is hidden, `-L` is follow-symlinks, `-s` is case-sensitive,
//      `-E` is encoding). Those are rewritten to their long forms or dropped.
//   2. grep's default dialect is BRE while rg uses Rust regex, so `a+` means a
//      literal "a+" to grep but one-or-more "a" to rg. A BRE pattern is only
//      rewritten when it is provably equivalent in both dialects — plain
//      literals, safe escapes, and BRE alternation (`\|` → `|`); otherwise we
//      refuse and leave the original `grep` command untouched.
//   3. `grep -r` implies `-H` (print the filename even for a single file, where
//      rg would omit it), so `-r`/`-R` become `--with-filename` rather than
//      being dropped outright.
//
// Behaviour note: `rg` respects `.gitignore` and skips hidden files by
// default; `grep -r` does not. That is the intended speed win and is surfaced
// to the model in the notice.

import { type ArgToken, token } from "../shell.ts";
import type { RuleDecision } from "../rules.ts";

type RegexMode = "basic" | "extended" | "fixed" | "perl";

const SHORT_BOOL: Record<string, { out: string[]; mode?: RegexMode }> = {
  i: { out: ["-i"] },
  v: { out: ["-v"] },
  w: { out: ["-w"] },
  x: { out: ["-x"] },
  c: { out: ["-c"] },
  l: { out: ["-l"] },
  n: { out: ["-n"] },
  o: { out: ["-o"] },
  q: { out: ["-q"] },
  a: { out: ["-a"] },
  F: { out: [], mode: "fixed" },
  P: { out: [], mode: "perl" },
  E: { out: [], mode: "extended" },
  G: { out: [], mode: "basic" },
  r: { out: ["--with-filename"] },
  R: { out: ["-L", "--with-filename"] },
  L: { out: ["--files-without-match"] },
  H: { out: ["--with-filename"] },
  h: { out: ["--no-filename"] },
  s: { out: ["--no-messages"] },
  I: { out: [] },
};

const SHORT_TAKES_VALUE = new Set(["e", "f", "m", "A", "B", "C"]);

/** Long options that map to a fixed set of replacement tokens. */
const LONG_BOOL: Record<string, { out: string[]; mode?: RegexMode }> = {
  "ignore-case": { out: ["-i"] },
  "invert-match": { out: ["-v"] },
  "word-regexp": { out: ["-w"] },
  "line-regexp": { out: ["-x"] },
  count: { out: ["-c"] },
  "files-with-matches": { out: ["-l"] },
  "files-without-match": { out: ["--files-without-match"] },
  "line-number": { out: ["-n"] },
  "only-matching": { out: ["-o"] },
  quiet: { out: ["-q"] },
  silent: { out: ["-q"] },
  text: { out: ["-a"] },
  recursive: { out: ["--with-filename"] },
  "dereference-recursive": { out: ["-L", "--with-filename"] },
  "with-filename": { out: ["--with-filename"] },
  "no-filename": { out: ["--no-filename"] },
  "no-messages": { out: ["--no-messages"] },
  "fixed-strings": { out: [], mode: "fixed" },
  "perl-regexp": { out: [], mode: "perl" },
  "extended-regexp": { out: [], mode: "extended" },
  "basic-regexp": { out: [], mode: "basic" },
  "line-buffered": { out: ["--line-buffered"] },
};

/** Long options that take their value with `=` or the next token. */
const LONG_TAKES_VALUE: Record<string, string> = {
  regexp: "-e",
  file: "-f",
  "max-count": "-m",
  "after-context": "-A",
  "before-context": "-B",
  context: "-C",
};

/**
 * Translate a **basic** (BRE) pattern to an equivalent Rust regex, or
 * `undefined` when no faithful translation exists.
 *
 * Rust regex is ERE-like: `+ ? ( ) { } |` are operators. In BRE they are
 * literals, so any unescaped occurrence is a semantic difference. Backslash
 * escapes are only safe for the punctuation that means the same literal in
 * both dialects (`\.` `\*` `\[` `\]` `\^` `\$` `\\` and `\-`); BRE operators
 * like `\+`, `\?`, `\(` and GNU `\<`/`\>` are not.
 *
 * BRE's GNU alternation operator `\|` is the exception: it means alternation
 * under both dialects, but is written differently (`a\|b` vs `a|b`), so the
 * backslash is dropped. This is the most common real-world pattern by far
 * (`grep 'FAIL\|Test Files'`), so refusing it would leave the majority of
 * `grep` calls untouched.
 */
export function breToRust(pattern: string): string | undefined {
  if (pattern.startsWith("*")) return undefined; // BRE literal `*`, Rust regex error
  let out = "";
  // Conservative bracket tracking: a `\|` inside `[...]` is a literal backslash
  // in grep (POSIX leaves it undefined; GNU grep treats `\` literally there),
  // while a translated `|` would be a class member — so refuse rather than
  // guess. Other backslashes keep their existing handling.
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "[") {
      inClass = true;
      out += c;
      continue;
    }
    if (c === "]") {
      inClass = false;
      out += c;
      continue;
    }
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return undefined;
      if (next === "|") {
        if (inClass) return undefined; // class member, not alternation
        out += "|"; // BRE alternation → Rust alternation
        i++;
        continue;
      }
      if (!".[]^$*\\/-".includes(next)) return undefined;
      out += `\\${next}`;
      i++;
      continue;
    }
    if ("+?(){}|".includes(c)) return undefined;
    out += c;
  }
  return out;
}

/**
 * True when a BRE pattern means exactly the same thing under Rust regex — that
 * is, it needs no rewriting. Patterns that use `\|` are *translatable* but not
 * identical; see {@link breToRust}.
 */
export function isBreRustCompatible(pattern: string): boolean {
  return breToRust(pattern) === pattern;
}

/**
 * Rewrite one pattern token for `rg`, or `undefined` to refuse.
 *
 * A quoted BRE pattern (`'A\|B'`) becomes a quoted Rust pattern (`'A|B'`). A
 * token whose value the shell already unescaped (`grep a\|b` → value `a|b`) is
 * refused: it is already a literal `|` to grep, so turning it into alternation
 * would change what matches. Rewriting a token whose raw text carries a shell
 * expansion (`"$PAT\|X"`) would freeze the variable, so that refuses too.
 */
function translatePatternToken(arg: ArgToken): ArgToken | undefined {
  const translated = breToRust(arg.value);
  if (translated === undefined) return undefined;
  if (translated === arg.value) return arg;
  if (/[$`]/.test(arg.text)) return undefined;
  return token(translated);
}

function outOf(tokens: readonly string[]): ArgToken[] {
  return tokens.map((t) => token(t));
}

/**
 * Translate a `grep` argv (the tokens after `grep`) into `rg` argv, or refuse.
 */
export function translateGrep(args: readonly ArgToken[]): RuleDecision {
  const emit: ArgToken[] = [];
  const positionals: ArgToken[] = [];
  /** Indices in `emit` holding the value of a `-e`/`--regexp` pattern. */
  const ePatternIndices: number[] = [];
  let sawE = false;
  let sawF = false;
  let mode: RegexMode = "basic";
  let afterDoubleDash = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    const value = arg.value;

    if (afterDoubleDash || value === "-" || !value.startsWith("-")) {
      positionals.push(arg);
      i++;
      continue;
    }

    if (value === "--") {
      afterDoubleDash = true;
      i++;
      continue;
    }

    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = (eq === -1 ? value : value.slice(0, eq)).slice(2);
      const inline = eq === -1 ? undefined : value.slice(eq + 1);

      const bool = LONG_BOOL[name];
      if (bool) {
        if (inline !== undefined) return { kind: "refuse", reason: `--${name} does not take a value` };
        emit.push(...outOf(bool.out));
        mode = bool.mode ?? mode;
        i++;
        continue;
      }

      if (name === "color" || name === "colour") {
        emit.push(token(inline === undefined ? "--color" : `--color=${inline}`));
        i++;
        continue;
      }

      if (name === "include" || name === "exclude" || name === "exclude-dir") {
        let globValue: string;
        if (inline !== undefined) {
          globValue = inline;
        } else {
          const next = args[i + 1];
          if (next === undefined) return { kind: "refuse", reason: `--${name} needs a value` };
          globValue = next.value;
          i++;
        }
        // rg's `-g` accepts a leading `!` to negate a glob.
        const negated = name === "exclude" || name === "exclude-dir";
        const glob = name === "exclude-dir" ? `${globValue}/**` : globValue;
        emit.push(token("-g"), token(negated ? `!${glob}` : glob));
        i++;
        continue;
      }

      const takesValue = LONG_TAKES_VALUE[name];
      if (takesValue !== undefined) {
        let valueToken: ArgToken;
        if (inline !== undefined) {
          valueToken = token(inline);
        } else {
          const next = args[i + 1];
          if (next === undefined) return { kind: "refuse", reason: `--${name} needs a value` };
          valueToken = next;
          i++;
        }
        emit.push(token(takesValue));
        if (takesValue === "-e") {
          sawE = true;
          ePatternIndices.push(emit.length);
        } else if (takesValue === "-f") {
          sawF = true;
        }
        emit.push(valueToken);
        i++;
        continue;
      }

      return { kind: "refuse", reason: `unsupported grep option --${name}` };
    }

    // Short option cluster, e.g. `-rn`, `-ne`, `-ePATTERN`.
    const cluster = value.slice(1);
    let handled = true;
    for (let c = 0; c < cluster.length; c++) {
      const ch = cluster[c]!;
      const bool = SHORT_BOOL[ch];
      if (bool) {
        emit.push(...outOf(bool.out));
        mode = bool.mode ?? mode;
        continue;
      }
      if (SHORT_TAKES_VALUE.has(ch)) {
        let valueToken: ArgToken;
        const rest = cluster.slice(c + 1);
        if (rest.length > 0) {
          valueToken = token(rest);
        } else {
          const next = args[i + 1];
          if (next === undefined) return { kind: "refuse", reason: `-${ch} needs a value` };
          valueToken = next;
          i++;
        }
        emit.push(token(`-${ch}`));
        if (ch === "e") {
          sawE = true;
          ePatternIndices.push(emit.length);
        } else if (ch === "f") {
          sawF = true;
        }
        emit.push(valueToken);
        c = cluster.length; // value consumed the rest of the cluster
        continue;
      }
      handled = false;
      break;
    }
    if (!handled) return { kind: "refuse", reason: `unsupported grep option ${value}` };
    i++;
  }

  // Determine the pattern(s) and files.
  const positionalPatternFirst = !sawE && !sawF;
  const files = positionalPatternFirst ? positionals.slice(1) : positionals;
  let positionalPattern = positionalPatternFirst && positionals.length > 0 ? positionals[0]! : undefined;

  // Dialect safety: only BRE (the default) needs the gate. A translatable
  // pattern (`A\|B`) is rewritten where it sits; anything else refuses.
  if (mode === "basic") {
    if (sawF) return { kind: "refuse", reason: "BRE patterns read from a file cannot be checked" };
    for (const index of ePatternIndices) {
      const rewritten = translatePatternToken(emit[index]!);
      if (rewritten === undefined) {
        return { kind: "refuse", reason: `pattern ${JSON.stringify(emit[index]!.value)} uses BRE syntax with no faithful rg equivalent` };
      }
      emit[index] = rewritten;
    }
    if (positionalPattern) {
      const rewritten = translatePatternToken(positionalPattern);
      if (rewritten === undefined) {
        return { kind: "refuse", reason: `pattern ${JSON.stringify(positionalPattern.value)} uses BRE syntax with no faithful rg equivalent` };
      }
      positionalPattern = rewritten;
    }
  }

  const out: ArgToken[] = [];
  // The regex-mode flag is emitted from the *final* mode: grep is last-flag-wins,
  // so `grep -F -E` is ERE (no flag) and `grep -E -F` is fixed (`-F`).
  if (mode === "fixed") out.push(token("-F"));
  else if (mode === "perl") out.push(token("-P"));
  out.push(...emit);
  if (!sawE && positionalPattern) out.push(positionalPattern);
  out.push(...files);

  if (out.length === 0) return { kind: "noop" };

  return {
    kind: "rewrite",
    name: "rg",
    args: out,
    notes: ["grep→rg", "ripgrep respects .gitignore and skips hidden files; add -u to search all"],
  };
}