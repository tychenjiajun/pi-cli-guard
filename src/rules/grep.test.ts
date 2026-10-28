import { describe, expect, it } from "vitest";

import { breToRust, isBreRustCompatible, translateGrep } from "./grep.ts";
import type { ArgToken } from "../shell.ts";
import { joinTokens } from "../shell.ts";

/** Build tokens from a raw-text list; value defaults to the raw text with quotes stripped. */
function toks(...specs: (string | [string, string])[]): ArgToken[] {
  return specs.map((spec) => {
    if (typeof spec === "string") {
      // Mimic unbash: a surrounding quote pair is stripped from `value`.
      const match = /^(["'])(.*)\1$/s.exec(spec);
      return { text: spec, value: match ? match[2]! : spec };
    }
    return { text: spec[0], value: spec[1] };
  });
}

function render(args: ArgToken[]): string {
  const decision = translateGrep(args);
  if (decision.kind === "rewrite") {
    return decision.args.length > 0 ? `${decision.name} ${joinTokens(decision.args)}` : decision.name!;
  }
  if (decision.kind === "refuse") return `REFUSE: ${decision.reason}`;
  return "noop";
}

describe("translateGrep — flag mapping", () => {
  it("passes `.` when -r has no path, like grep does", () => {
    // `rg pattern` with no path reads stdin when it is not a terminal; grep -r
    // always searches `.`, and its output carries the `./` prefix.
    expect(render(toks("-rn", "foo"))).toBe("rg --with-filename -n foo .");
    expect(render(toks("-rl", "foo"))).toBe("rg --with-filename -l --binary foo .");
    expect(render(toks("-r", "-e", "foo"))).toBe("rg --with-filename -e foo .");
  });

  it("drops -r and keeps -n", () => {
    expect(render(toks("-rn", "foo", "src"))).toBe("rg --with-filename -n foo src");
  });

  it("splits clustered short flags", () => {
    expect(render(toks("-rln", "foo", "src"))).toBe("rg --with-filename -l -n --binary foo src");
  });

  it("maps -R to -L (follow symlinks)", () => {
    expect(render(toks("-R", "foo", "."))).toBe("rg -L --with-filename foo .");
  });

  it("passes --binary with -l/-L, which grep lists but rg filters out", () => {
    // Over a directory walk rg hides binary files from -l/-L; grep reports them.
    expect(render(toks("-rl", "foo", "."))).toBe("rg --with-filename -l --binary foo .");
    expect(render(toks("-rL", "foo", "."))).toBe(
      "rg --with-filename --files-without-match --binary foo .",
    );
  });

  it("maps -L to --files-without-match (rg -L means follow)", () => {
    expect(render(toks("-L", "foo", "."))).toBe("rg --files-without-match --binary foo .");
  });

  it("maps -h to --no-filename (rg -h is help)", () => {
    expect(render(toks("-h", "foo"))).toBe("rg --no-filename foo");
  });

  it("maps -H to --with-filename (rg -H is hidden)", () => {
    expect(render(toks("-H", "foo"))).toBe("rg --with-filename foo");
  });

  it("emits exactly one filename flag, with -h winning over -r/-H", () => {
    // grep's -h suppresses the prefix even though -r implies -H; emitting both
    // flags would let rg's last-one-wins order decide, which is not grep.
    expect(render(toks("-h", "-r", "foo", "."))).toBe("rg --no-filename foo .");
    expect(render(toks("-r", "-h", "foo", "."))).toBe("rg --no-filename foo .");
    expect(render(toks("-hn", "-r", "foo", "."))).toBe("rg --no-filename -n foo .");
    expect(render(toks("-h", "-H", "foo", "f"))).toBe("rg --no-filename foo f");
    expect(render(toks("-r", "-H", "foo", "f"))).toBe("rg --with-filename foo f");
  });

  it("maps -s to --no-messages (rg -s is case-sensitive)", () => {
    expect(render(toks("-s", "foo"))).toBe("rg --no-messages foo");
  });

  it("refuses -I: grep skips binary files, ripgrep reports them", () => {
    // `grep -I foo bin` exits 1; `rg foo bin` prints "binary file matches"
    // and exits 0. ripgrep has no --binary-files=without-match equivalent.
    expect(render(toks("-I", "foo", "."))).toMatch(/^REFUSE: .*-I/);
  });

  it("refuses -m 0, where grep and rg disagree about `no limit`", () => {
    expect(render(toks("-m", "0", "foo", "f"))).toMatch(/^REFUSE: .*-m 0/);
    expect(render(toks("-m0", "foo", "f"))).toMatch(/^REFUSE: .*-m 0/);
    expect(render(toks("--max-count=0", "foo", "f"))).toMatch(/^REFUSE: .*-m 0/);
  });

  it("refuses -c combined with -l/-L, where grep and rg pick different outputs", () => {
    expect(render(toks("-cl", "foo", "a", "b"))).toMatch(/^REFUSE: .*-c.*-l/);
    expect(render(toks("-c", "-L", "foo", "a", "b"))).toMatch(/^REFUSE: .*-c.*-l/);
  });

  it("keeps the common passthrough flags", () => {
    expect(render(toks("-ivwxno", "foo", "."))).toBe("rg -i -v -w -x -n -o foo .");
  });

  it("adds --include-zero so -c still reports files with zero matches", () => {
    // `grep -c` prints `file:0` for every searched file; `rg -c` omits them.
    expect(render(toks("-c", "foo", "a.txt", "b.txt"))).toBe("rg -c --include-zero foo a.txt b.txt");
    expect(render(toks("-rc", "foo", "."))).toBe("rg --with-filename -c --include-zero foo .");
  });

  it("maps --include to a positive -g glob", () => {
    // grep's --include does not skip ignored/hidden files, but an rg whitelist
    // glob *does* override its ignore rules — so pin the rest of grep's scope.
    expect(render(toks("-rn", "--include=*.ts", "foo", "src"))).toBe(
      "rg --with-filename -n -g '*.ts' --hidden --no-ignore foo src",
    );
  });

  it("maps --exclude to a negated -g glob", () => {
    expect(render(toks("--exclude=*.min.js", "foo", "."))).toBe("rg -g '!*.min.js' foo .");
  });

  it("maps --exclude-dir to a negated directory glob", () => {
    expect(render(toks("--exclude-dir=node_modules", "foo", "."))).toBe("rg -g '!node_modules/**' foo .");
  });

  it("keeps --color with its value", () => {
    expect(render(toks("--color=always", "foo", "."))).toBe("rg --color=always foo .");
  });

  it("translates long boolean forms", () => {
    expect(render(toks("--ignore-case", "--line-number", "foo", "."))).toBe("rg -i -n foo .");
  });

  it("keeps options that take a value", () => {
    expect(render(toks("-m", "3", "foo", "f"))).toBe("rg -m 3 foo f");
    expect(render(toks("-A", "2", "-B", "1", "foo", "f"))).toBe("rg -A 2 -B 1 foo f");
  });

  it("keeps -e patterns as -e", () => {
    expect(render(toks("-e", "foo", "-e", "bar", "f"))).toBe("rg -e foo -e bar f");
  });

  it("supports the attached form -ePATTERN", () => {
    expect(render(toks("-nefoo", "f"))).toBe("rg -n -e foo f");
  });

  it("rewrites a directory search even without -r (grep errors, rg searches)", () => {
    // Documented divergence: `grep foo .` fails with "Is a directory"; rg
    // treats the directory as a recursive search root. The rewrite turns a
    // model mistake into working behaviour.
    expect(render(toks("foo", "."))).toBe("rg foo .");
  });
});

describe("translateGrep — notes", () => {
  function notes(args: ArgToken[]): string {
    const decision = translateGrep(args);
    if (decision.kind !== "rewrite") throw new Error(`not a rewrite: ${decision.kind}`);
    return decision.notes.join("\n");
  }

  it("tells the model that ripgrep skips ignored/hidden files", () => {
    expect(notes(toks("-rn", "foo", "."))).toContain("skips .gitignore'd and hidden files");
  });

  it("warns that binary-file diagnostics and counts differ", () => {
    expect(notes(toks("-rn", "foo", "."))).toContain("binary file matches");
  });

  it("warns that rg is recursive without -r, so a directory argument now works", () => {
    expect(notes(toks("-l", "foo", "."))).toContain("recursive even without -r");
  });

  it("tells the model when --include turned the ignore rules off", () => {
    const text = notes(toks("-rn", "--include=*.ts", "foo", "."));
    expect(text).toContain("--include");
    expect(text).toContain("--hidden --no-ignore");
    expect(text).not.toContain("skips hidden");
  });
});

describe("translateGrep — dialect safety", () => {
  it("rewrites a BRE pattern that is identical under Rust regex", () => {
    expect(render(toks("-rn", "'10\\.128\\.3\\.143'", "."))).toBe("rg --with-filename -n '10\\.128\\.3\\.143' .");
  });

  it("keeps an extended regex (ERE matches Rust regex)", () => {
    expect(render(toks("-E", "'a|b'", "f"))).toBe("rg 'a|b' f");
  });

  it("keeps a fixed-string pattern unchanged", () => {
    expect(render(toks("-F", "'a+'", "f"))).toBe("rg -F 'a+' f");
  });

  it("keeps a perl-regex pattern via -P", () => {
    expect(render(toks("-P", "'\\d+'", "f"))).toBe("rg -P '\\d+' f");
  });

  it("refuses a BRE pattern with a doubled star (grep: syntax error, rg: matches)", () => {
    expect(breToRust("a**")).toBeUndefined();
    expect(breToRust("a***b")).toBeUndefined();
    // An escaped star is a literal in both dialects, so `\**` stays usable.
    expect(breToRust("a\\**")).toBe("a\\**");
    expect(render(toks("'a**'", "f"))).toMatch(/^REFUSE:/);
  });

  it("refuses a BRE pattern whose meaning changes", () => {
    expect(render(toks("a+", "f"))).toMatch(/^REFUSE/);
    expect(render(toks("foo?", "f"))).toMatch(/^REFUSE/);
    expect(render(toks("a\\+", "f"))).toMatch(/^REFUSE/);
    expect(render(toks("\\<foo\\>", "f"))).toMatch(/^REFUSE/);
  });

  it("refuses BRE patterns read from a file", () => {
    expect(render(toks("-f", "patterns.txt", "f"))).toMatch(/^REFUSE/);
  });

  it("refuses unsupported options", () => {
    expect(render(toks("-Z", "foo", "."))).toMatch(/^REFUSE/);
    expect(render(toks("--binary-files=text", "foo", "."))).toMatch(/^REFUSE/);
  });

  it("honours last-flag-wins for the regex dialect", () => {
    expect(render(toks("-F", "-E", "'a+'", "f"))).toBe("rg 'a+' f");
    expect(render(toks("-E", "-F", "'a+'", "f"))).toBe("rg -F 'a+' f");
    expect(render(toks("-F", "-G", "'a+'", "f"))).toMatch(/^REFUSE/);
  });
});

describe("translateGrep — BRE alternation (`\\|` → `|`)", () => {
  it("translates the single most common real-world pattern", () => {
    expect(render(toks("'Test Files\\|Tests '", "f"))).toBe("rg 'Test Files|Tests ' f");
  });

  it("translates chained alternation", () => {
    expect(render(toks("-rn", "'FAIL\\|Test Files\\|Tests '", "."))).toBe(
      "rg --with-filename -n 'FAIL|Test Files|Tests ' .",
    );
    expect(render(toks("-n", "'✓\\|×\\|Test Files'", "f"))).toBe("rg -n '✓|×|Test Files' f");
  });

  it("translates alternation next to a safe escape", () => {
    expect(render(toks("-rn", "'10\\.0\\|20\\.0'", "."))).toBe(
      "rg --with-filename -n '10\\.0|20\\.0' .",
    );
  });

  it("translates alternation inside a -e pattern", () => {
    expect(render(toks("-e", "'a\\|b'", "f"))).toBe("rg -e 'a|b' f");
    expect(render(toks("-nefoo\\|bar", "f"))).toBe("rg -n -e 'foo|bar' f");
  });

  it("leaves an -F pattern alone (`\\|` is literal under fixed strings)", () => {
    expect(render(toks("-F", "'a\\|b'", "f"))).toBe("rg -F 'a\\|b' f");
  });

  it("refuses once the pattern also uses an untranslatable BRE operator", () => {
    expect(render(toks("'a+\\|b'", "f"))).toMatch(/^REFUSE/);
    expect(render(toks("-n", "'^[[:space:]]\\+import'", "f"))).toMatch(/^REFUSE/);
  });

  it("refuses an unquoted pipe the shell already unescaped", () => {
    // `grep a\|b` reaches grep as `a|b` (a literal pipe in BRE); rg would read
    // `a|b` as alternation, so this must not be rewritten.
    expect(render(toks(["a\\|b", "a|b"], "f"))).toMatch(/^REFUSE/);
  });

  it("refuses a pattern carrying a shell expansion", () => {
    expect(render(toks('"$PAT\\|X"', "f"))).toMatch(/^REFUSE/);
  });

  it("refuses `\\|` inside a bracket expression", () => {
    // In grep `[a\|b]` is a class containing backslash and pipe; a translated
    // `[a|b]` would be a different class, so it must not be rewritten.
    expect(render(toks("'[a\\|b]'", "f"))).toMatch(/^REFUSE/);
  });
});

describe("isBreRustCompatible", () => {
  it("accepts plain literals and safe escapes", () => {
    for (const p of ["foo", "foo bar", "^foo$", "a.*b", "10\\.128", "a\\*b"]) {
      expect(isBreRustCompatible(p), p).toBe(true);
    }
  });

  it("rejects a `+` even inside a character class", () => {
    expect(isBreRustCompatible("[0-9]+")).toBe(false);
  });

  it("rejects BRE operators and GNU escapes", () => {
    for (const p of ["a+", "a?", "(a)", "a{2}", "a|b", "a\\+", "a\\?", "\\(a\\)", "\\<foo\\>", "*foo"]) {
      expect(isBreRustCompatible(p), p).toBe(false);
    }
  });

  it("treats BRE alternation as translatable but not identical", () => {
    // `a\|b` is not *identical* under Rust regex (it must be rewritten to
    // `a|b`), so the identity predicate rejects it while `breToRust` accepts it.
    expect(isBreRustCompatible("a\\|b")).toBe(false);
    expect(breToRust("a\\|b")).toBe("a|b");
    expect(breToRust("A\\|B\\|C")).toBe("A|B|C");
    expect(breToRust("10\\.0\\|20\\.0")).toBe("10\\.0|20\\.0");
    expect(breToRust("a+")).toBeUndefined();
    expect(breToRust("a\\+")).toBeUndefined();
  });
});
