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

function positiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Translate a `find` argv (tokens after `find`) into `fd` argv, or refuse.
 */
export function translateFind(args: readonly ArgToken[]): RuleDecision {
  const paths: ArgToken[] = [];
  const globs: Glob[] = [];
  const types: string[] = [];
  let maxDepth: number | undefined;
  let minDepth: number | undefined;
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
      if (value === "-maxdepth") maxDepth = depth;
      else minDepth = depth;
      lastWasNameTest = false;
      i += 2;
      continue;
    }

    return { kind: "refuse", reason: `unsupported find expression ${JSON.stringify(value)}` };
  }

  if (expectingName) return { kind: "refuse", reason: "-o must be followed by -name/-iname" };

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
    notes: ["find→fd", "fd skips hidden and .gitignore'd paths; directories print with a trailing /; add -u to search all"],
  };
}