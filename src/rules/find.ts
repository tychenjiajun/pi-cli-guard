// ---------------------------------------------------------------------------
// find -> fd
// ---------------------------------------------------------------------------
//
// `find` is POSIX and its expression language (`-exec`, `-delete`, `-prune`,
// boolean `-o`/`-not`/`\( \)`, `-newer`, `-perm`, …) has no fd equivalent. This
// rule therefore rewrites only the small, high-frequency subset and refuses
// everything else, leaving the original command untouched.
//
// Two facts about fd drive the output shape:
//   * `--glob`/`-g` is a boolean switch; the pattern is the single positional
//     that follows, and it is a glob only because of `-g` (fd's default is a
//     regex). Multiple `find -name` globs joined by `-o` are combined into one
//     brace glob `{a,b}`.
//   * fd is case-insensitive for all-lowercase patterns ("smart case"), so a
//     case-sensitive `-name` needs an explicit `-s`, and `-iname` needs `-i`.
//
// Behaviour note: fd skips hidden files and `.gitignore`d paths by default;
// `find` does not. That is surfaced to the model in the notice.

import { type ArgToken, token } from "../shell.ts";
import type { RuleDecision } from "../rules.ts";

interface Glob {
  readonly glob: string;
  readonly caseInsensitive: boolean;
}

const TYPES = new Set(["f", "d", "l"]);

/** Escape a single character for fd/rg's Rust-regex dialect. */
function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Index of the `]` closing the character class at `open`, or -1. */
function classEnd(glob: string, open: number): number {
  let i = open + 1;
  if (glob[i] === "!" || glob[i] === "^") i++;
  if (glob[i] === "]") i++;
  for (; i < glob.length; i++) if (glob[i] === "]") return i;
  return -1;
}

/**
 * Translate a shell glob to the equivalent Rust regex. `star`/`question` are
 * the regex atoms for `*`/`?`: `.*`/`.` when the glob may cross `/` (find's
 * `-path`), `[^/]*`/`[^/]` when it must not (a basename). Returns `undefined`
 * for the two corners where find's glob syntax has no provable regex form: a
 * trailing lone backslash and an escape inside a bracket expression.
 */
function globToRegex(glob: string, star: string, question: string): string | undefined {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "\\") {
      const next = glob[i + 1];
      if (next === undefined) return undefined;
      out += escapeRegex(next);
      i++;
      continue;
    }
    if (char === "*") {
      out += star;
      continue;
    }
    if (char === "?") {
      out += question;
      continue;
    }
    if (char === "[") {
      const end = classEnd(glob, i);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, end);
      // `\` inside a bracket expression means something different to find and
      // to the regex engine; refuse rather than pick one.
      if (body.includes("\\")) return undefined;
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      else if (body.startsWith("^")) body = `\\^${body.slice(1)}`;
      out += `[${body}]`;
      i = end;
      continue;
    }
    out += escapeRegex(char);
  }
  return out;
}

function isOrToken(value: string): boolean {
  return value === "-o" || value === "-or";
}

/**
 * Drop grouping parentheses that cannot change meaning. A group with no `-o`
 * inside is a plain conjunction, and find's AND already binds tighter than any
 * surviving `-o`, so removing it is faithful. Returns `undefined` when a group
 * contains `-o` (real precedence) or the parentheses are unbalanced, so the
 * caller can refuse.
 */
function flattenRedundantGroups(args: readonly ArgToken[]): ArgToken[] | undefined {
  const out: ArgToken[] = [];
  const open: number[] = [];
  for (const arg of args) {
    if (arg.value === "(") {
      open.push(out.length);
      continue;
    }
    if (arg.value === ")") {
      const start = open.pop();
      if (start === undefined) return undefined;
      if (out.slice(start).some((entry) => isOrToken(entry.value))) return undefined;
      continue;
    }
    out.push(arg);
  }
  return open.length === 0 ? out : undefined;
}

/**
 * True when every alternative of a glob needs a leading dot to match. fd aborts
 * with an error on such a glob because it filters hidden entries by default.
 */
function onlyMatchesHidden(glob: string): boolean {
  const inner = glob.startsWith("{") && glob.endsWith("}") ? glob.slice(1, -1) : glob;
  return inner.split(",").every((part) => part.startsWith("."));
}

function positiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Translate a `find` argv (tokens after `find`) into `fd` argv, or refuse.
 */
export function translateFind(args: readonly ArgToken[]): RuleDecision {
  const flattened = flattenRedundantGroups(args);
  if (!flattened) {
    return { kind: "refuse", reason: "grouped expression with -o cannot be flattened faithfully" };
  }
  args = flattened;

  const paths: ArgToken[] = [];
  const globs: Glob[] = [];
  const types: string[] = [];
  let maxDepth: number | undefined;
  let minDepth: number | undefined;
  let pathGlob: string | undefined;
  let follow = false;

  let i = 0;

  // ── leading global options ────────────────────────────────────────────
  while (i < args.length) {
    const value = args[i]!.value;
    if (value === "-L") {
      follow = true;
      i++;
      continue;
    }
    if (value === "-H" || value === "-P") {
      i++;
      continue;
    }
    if (value === "-D" || value === "-O") {
      return { kind: "refuse", reason: `unsupported find option ${value}` };
    }
    break;
  }

  // ── search paths (up to the first expression token) ───────────────────
  while (i < args.length) {
    const value = args[i]!.value;
    if (value.startsWith("-") || value === "!" || value === "(" || value === ")") break;
    paths.push(args[i]!);
    i++;
  }

  // ── expression ────────────────────────────────────────────────────────
  let lastWasNameTest = false;
  let expectingName = false;

  const addGlob = (glob: string, caseInsensitive: boolean): RuleDecision | undefined => {
    if (glob.includes("/")) {
      return { kind: "refuse", reason: `-name glob ${JSON.stringify(glob)} contains a path separator` };
    }
    if (onlyMatchesHidden(glob)) {
      return {
        kind: "refuse",
        reason: `-name glob ${JSON.stringify(glob)} only matches hidden entries, which fd skips unless -H is passed`,
      };
    }
    if (globs.length > 0 && !expectingName) {
      return { kind: "refuse", reason: "multiple -name/-iname tests joined by implicit AND" };
    }
    globs.push({ glob, caseInsensitive });
    lastWasNameTest = true;
    expectingName = false;
    return undefined;
  };

  while (i < args.length) {
    const value = args[i]!.value;

    if (value === "-o" || value === "-or") {
      if (!lastWasNameTest) return { kind: "refuse", reason: "-o is only supported between -name/-iname tests" };
      expectingName = true;
      lastWasNameTest = false;
      i++;
      continue;
    }
    if (value === "-a" || value === "-and") {
      if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };
      i++;
      continue;
    }

    if (value === "-name" || value === "-iname") {
      const next = args[i + 1];
      if (next === undefined) return { kind: "refuse", reason: `${value} needs a value` };
      const problem = addGlob(next.value, value === "-iname");
      if (problem) return problem;
      i += 2;
      continue;
    }

    if (value === "-type") {
      if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };
      const next = args[i + 1];
      if (next === undefined) return { kind: "refuse", reason: "-type needs a value" };
      if (!TYPES.has(next.value)) return { kind: "refuse", reason: `unsupported -type ${next.value}` };
      if (types.length > 0 && !types.includes(next.value)) {
        return { kind: "refuse", reason: "multiple different -type tests combined with AND" };
      }
      if (!types.includes(next.value)) types.push(next.value);
      lastWasNameTest = false;
      i += 2;
      continue;
    }

    if (value === "-maxdepth" || value === "-mindepth") {
      if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };
      const next = args[i + 1];
      if (next === undefined) return { kind: "refuse", reason: `${value} needs a value` };
      const depth = positiveInt(next.value);
      if (depth === undefined) return { kind: "refuse", reason: `${value} expects a non-negative integer` };
      if (value === "-maxdepth" && depth === 0) {
        // `find . -maxdepth 0` prints just `.`; `fd -d 0` prints nothing.
        return { kind: "refuse", reason: "-maxdepth 0 has no fd equivalent (fd never lists the search root)" };
      }
      if (value === "-maxdepth") maxDepth = depth;
      else minDepth = depth;
      lastWasNameTest = false;
      i += 2;
      continue;
    }

    if (value === "-path") {
      if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };
      if (pathGlob !== undefined) return { kind: "refuse", reason: "multiple -path tests combine with AND" };
      const next = args[i + 1];
      if (next === undefined) return { kind: "refuse", reason: "-path needs a value" };
      if (!next.value.startsWith("*")) {
        return {
          kind: "refuse",
          reason: `anchored -path glob ${JSON.stringify(next.value)} cannot be mapped faithfully (fd matches absolute paths)`,
        };
      }
      pathGlob = next.value;
      lastWasNameTest = false;
      i += 2;
      continue;
    }

    return { kind: "refuse", reason: `unsupported find expression ${JSON.stringify(value)}` };
  }

  if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };

  if (pathGlob !== undefined) {
    if (globs.length > 1) {
      return { kind: "refuse", reason: "cannot combine -path with an -o name chain" };
    }
    if (globs.some((glob) => glob.caseInsensitive)) {
      return { kind: "refuse", reason: "cannot combine -path with -iname (fd's -i/-s is global)" };
    }
  }

  // `find`'s AND binds tighter than `-o`, so `-type f -name a -o -name b` means
  // `(-type f -name a) -o (-name b)`: the second branch is not type-filtered.
  // fd has no boolean OR between a `-t` filter and a `-g` glob, so a single fd
  // call would wrongly apply the type test to every branch. Refuse.
  if (globs.length > 1 && types.length > 0) {
    return { kind: "refuse", reason: "cannot combine -o name globs with a -type test" };
  }

  // ── build the fd invocation ───────────────────────────────────────────
  const out: ArgToken[] = [];
  if (follow) out.push(token("-L"));
  if (maxDepth !== undefined) out.push(token("-d"), token(String(maxDepth)));
  if (minDepth !== undefined) out.push(token("--min-depth"), token(String(minDepth)));
  for (const type of types) out.push(token("-t"), token(type));

  if (pathGlob !== undefined) {
    // `find -path` matches the whole path with a glob where `*` crosses `/`;
    // fd's `--full-path` matches a regex where `.*` crosses `/`. Both are
    // unanchored once the glob starts with `*`, which is why the leading-`*`
    // check above is what makes the mapping faithful.
    const pathRegex = globToRegex(pathGlob, ".*", ".");
    if (pathRegex === undefined) {
      return { kind: "refuse", reason: `-path glob ${JSON.stringify(pathGlob)} has no faithful regex form` };
    }
    out.push(token("-p"), token("-s"), token(pathRegex));
    if (globs.length === 1) {
      // `-name` still applies to the basename. `--and` also sees the full path
      // under `--full-path`, so anchor the basename regex at a separator.
      const nameRegex = globToRegex(globs[0]!.glob, "[^/]*", "[^/]");
      if (nameRegex === undefined) {
        return {
          kind: "refuse",
          reason: `-name glob ${JSON.stringify(globs[0]!.glob)} has no faithful regex form`,
        };
      }
      out.push(token("--and"), token(`(^|/)${nameRegex}$`));
    }
    if (paths.length === 0) out.push(token("."));
    for (const path of paths) out.push(path);
    return {
      kind: "rewrite",
      name: "fd",
      args: out,
      notes: [
        "find→fd",
        "fd matches -path against the full path with a regex; fd skips hidden and .gitignore'd paths (add -u to search all); directories print with a trailing / and fd never lists the search root itself",
      ],
    };
  }

  let pattern = ".";
  if (globs.length === 1) {
    pattern = globs[0]!.glob;
    out.push(token("-g"));
    out.push(token(globs[0]!.caseInsensitive ? "-i" : "-s"));
  } else if (globs.length > 1) {
    if (globs.some((g) => /[{},]/.test(g.glob))) {
      return { kind: "refuse", reason: "cannot combine -o globs that contain {, } or ," };
    }
    pattern = `{${globs.map((g) => g.glob).join(",")}}`;
    out.push(token("-g"));
    const anyInsensitive = globs.some((g) => g.caseInsensitive);
    const anySensitive = globs.some((g) => !g.caseInsensitive);
    if (anyInsensitive && anySensitive) {
      return { kind: "refuse", reason: "cannot mix -name and -iname under one -o" };
    }
    out.push(token(anyInsensitive ? "-i" : "-s"));
  }

  out.push(token(pattern));
  // fd prints `./`-prefixed paths only when a path argument is given, and find
  // defaults to `.`; pass a path so file listings match. (Directories still
  // gain a trailing `/` and the root itself is not listed — fd's own format.)
  if (paths.length === 0) out.push(token("."));
  for (const path of paths) out.push(path);

  return {
    kind: "rewrite",
    // The engine overrides this with the resolved binary name (`fd` or the
    // Debian alias `fdfind`); the rule stays pure.
    name: "fd",
    args: out,
    notes: [
      "find→fd",
      "fd skips hidden and .gitignore'd paths (add -u to search all); directories print with a trailing / and fd never lists the search root itself",
    ],
  };
}
