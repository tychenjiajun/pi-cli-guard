// ---------------------------------------------------------------------------
// End-to-end equivalence with the real binaries
// ---------------------------------------------------------------------------
//
// These tests are the strongest guard against a translation that looks right
// but changes what the shell returns: they run the original `grep`/`find`
// command and the guard's rewritten command and compare stdout. They are
// skipped when `rg`/`fd` are not installed, so CI without them still passes.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteCommand, type EnabledRule } from "./engine.ts";
import { RULES } from "./rules.ts";

function installed(binary: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasRg = installed("rg");
const fdName = installed("fd") ? "fd" : installed("fdfind") ? "fdfind" : undefined;

const enabled: EnabledRule[] = [
  ...(hasRg
    ? [
        { rule: RULES["grep-to-rg"], binary: "rg" },
        { rule: RULES["egrep-to-rg"], binary: "rg" },
        { rule: RULES["fgrep-to-rg"], binary: "rg" },
      ]
    : []),
  ...(fdName ? [{ rule: RULES["find-to-fd"], binary: fdName }] : []),
];

let dir: string;
/** Second root with hidden + `.gitignore`d files: the guard deliberately skips
 * them, except where grep itself searched them (`--include`). */
let skipDir: string;
/** Third root: a binary file with and without a match (`-l`/`-L`). */
let binDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-cli-guard-eq-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "foo bar\nbaz\n");
  writeFileSync(join(dir, "b.txt"), "foo\n");
  writeFileSync(join(dir, "sub", "c.txt"), "nope\n");
  writeFileSync(join(dir, "sub", "d.log"), "foo log\n");
  writeFileSync(join(dir, "e.txt"), "a+\n");
  // No match: `grep -c` must still report `miss.txt:0`.
  writeFileSync(join(dir, "miss.txt"), "nothing here\n");

  skipDir = mkdtempSync(join(tmpdir(), "pi-cli-guard-eq-skip-"));
  mkdirSync(join(skipDir, "sub"));
  mkdirSync(join(skipDir, ".hid"));
  writeFileSync(join(skipDir, "a.txt"), "foo\n");
  writeFileSync(join(skipDir, "sub", "c.txt"), "foo\n");
  writeFileSync(join(skipDir, ".hidden.txt"), "foo\n");
  writeFileSync(join(skipDir, ".hid", "alpha.txt"), "foo\n");
  writeFileSync(join(skipDir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(skipDir, "ignored.txt"), "foo\n");
  execFileSync("git", ["init", "-q"], { cwd: skipDir, stdio: "ignore" });

  binDir = mkdtempSync(join(tmpdir(), "pi-cli-guard-eq-bin-"));
  writeFileSync(join(binDir, "text.txt"), "foo\n");
  writeFileSync(join(binDir, "hit.bin"), Buffer.from("foo\0\0foo\n"));
  writeFileSync(join(binDir, "miss.bin"), Buffer.from("zzz\0zzz\n"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(skipDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

function run(command: string, cwd = dir): string {
  // spawnSync, not execFileSync: `grep -L` exits 1 on some greps even when it
  // printed results, and the suite judges stdout only.
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
  });
  return (result.stdout ?? "").split("\n").filter((line) => line.length > 0).sort().join("\n");
}

/** Run the original and the rewritten command and assert identical stdout. */
function expectSame(original: string, cwd = dir): void {
  const rewritten = rewriteCommand(original, enabled).command;
  expect(rewritten, `did not rewrite: ${original}`).not.toBe(original);
  expect(run(rewritten, cwd), `rewrite: ${rewritten}`).toBe(run(original, cwd));
}

/**
 * fd appends a trailing `/` to matched directories and never lists the `.`
 * search root, whereas find prints `./sub` and lists `.`. Strip both so the
 * comparison judges the translation rather than these documented, cosmetic
 * fd format differences.
 */
function normalizeForFd(output: string): string {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/\/$/, ""))
    .filter((line) => line !== ".")
    .sort()
    .join("\n");
}

/** Run original vs rewritten and compare, tolerating fd's directory format. */
function expectSameNormalized(original: string): void {
  const rewritten = rewriteCommand(original, enabled).command;
  expect(rewritten, `did not rewrite: ${original}`).not.toBe(original);
  expect(normalizeForFd(run(rewritten)), `rewrite: ${rewritten}`).toBe(normalizeForFd(run(original)));
}

describe.skipIf(!hasRg)("grep → rg equivalence (real rg)", () => {
  const cases = [
    "grep -n foo a.txt",
    "grep -c foo a.txt",
    "grep -c foo a.txt miss.txt",
    "grep -rc foo .",
    "grep -hn -r foo .",
    "grep -r -h foo .",
    "grep -hn -r foo sub",
    "grep -rn foo .",
    // No path: grep -r searches `.`; the rewrite must pass it explicitly.
    "grep -rn foo",
    "grep -rl foo",
    "grep -rn foo a.txt",
    "grep -rln foo .",
    "grep -rF 'a+' .",
    "grep -rE 'f.o' .",
    "grep -riv foo .",
    "grep -rw foo .",
    "grep -ro foo .",
    "grep --include='*.txt' -rn foo .",
    "grep -rn --exclude='*.log' foo .",
    // BRE alternation, the most common real-world grep pattern.
    "grep -rn 'foo\\|baz' .",
    "grep -rn 'nope\\|bar' .",
    "grep -cE '^fo' a.txt",
    "grep -A1 foo a.txt",
    "grep -B1 baz a.txt",
    "grep -v foo a.txt",
    // egrep/fgrep run through the same translator with an implicit dialect.
    "egrep -rn 'foo|baz' .",
    "egrep -c '^fo' a.txt",
    "fgrep -rn 'a+' .",
    "fgrep -l foo a.txt b.txt",
  ];
  for (const command of cases) {
    it(command, () => expectSame(command));
  }
});

describe.skipIf(!hasRg)("grep → rg equivalence where grep searched ignored/hidden files", () => {
  // `--include` is a whitelist, and ripgrep whitelists override its ignore
  // rules, so a `-g` rewrite would surface files grep skipped... except that
  // grep *did* search them: `grep -r --include` ignores `.gitignore` and dot
  // files unless told otherwise. The rewrite must therefore disable both.
  for (const command of ["grep --include='*.txt' -rn foo .", "grep --include='*.txt' -rc foo ."]) {
    it(command, () => expectSame(command, skipDir));
  }

  // Documented divergence: without `--include` the guard keeps ripgrep's
  // ignore rules, so it finds strictly fewer files than grep -r.
  it("grep -rn foo . (documented skip)", () => {
    const rewritten = rewriteCommand("grep -rn foo .", enabled).command;
    expect(rewritten).toBe("rg --with-filename -n foo .");
    const before = run("grep -rn foo .", skipDir).split("\n");
    const after = run(rewritten, skipDir).split("\n");
    expect(after.every((line) => before.includes(line))).toBe(true);
    expect(after).toContain("./a.txt:1:foo");
    expect(after.join("\n")).not.toContain("hidden");
    expect(after.join("\n")).not.toContain("ignored");
  });
});

describe.skipIf(!hasRg)("grep → rg equivalence over binary files", () => {
  // grep reports binary files for -l/-L; ripgrep filters them out of a
  // directory walk unless --binary is passed.
  for (const command of ["grep -rl foo .", "grep -rL foo ."]) {
    it(command, () => expectSame(command, binDir));
  }
});

describe("refusals leave the model's command untouched", () => {
  // Each of these has no faithful `rg`/`fd` spelling; running the original keeps
  // grep/find semantics instead of silently returning different results.
  const refused = [
    "grep -I foo bin.dat",
    "grep -m 0 foo a.txt",
    "grep -c -l foo a.txt b.txt",
    "grep 'a**' a.txt",
    "find . -maxdepth 0",
    "find . -name '.*'",
    "find . -iname '.env*'",
  ];
  for (const command of refused) {
    it(command, () => {
      expect(rewriteCommand(command, enabled).command).toBe(command);
    });
  }
});

describe.skipIf(!fdName)("find → fd equivalence (real fd)", () => {
  const fileCases = [
    "find . -name '*.txt'",
    "find . -type f",
    "find . -type f -name '*.txt'",
    "find sub -name '*.log'",
    "find . -maxdepth 1 -name '*.txt'",
    "find . -name '*.txt' -o -name '*.log'",
    "find . -name '*.txt' -type f",
    "find . -path '*sub*' -name '*.txt'",
    "find . -type f -path '*.txt'",
    "find . -path '*[ab].txt'",
    "find . -path '*?.txt'",
    "find . -path '*[!x]*.txt' -type f",
    "find . \\( -type f -name '*.txt' \\)",
  ];
  for (const command of fileCases) {
    it(command, () => expectSame(command));
  }

  // `find` prints `./sub` and lists `.`; fd prints `./sub/` and omits the root.
  // Both differences are documented in the notice, so compare normalized.
  const dirCases = ["find . -type d", "find . -path '*sub*'"];
  for (const command of dirCases) {
    it(`${command} (normalized for fd's directory format)`, () => expectSameNormalized(command));
  }
});
