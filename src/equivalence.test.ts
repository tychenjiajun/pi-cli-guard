// ---------------------------------------------------------------------------
// End-to-end equivalence with the real binaries
// ---------------------------------------------------------------------------
//
// These tests are the strongest guard against a translation that looks right
// but changes what the shell returns: they run the original `grep`/`find`
// command and the guard's rewritten command and compare stdout. They are
// skipped when `rg`/`fd` are not installed, so CI without them still passes.

import { execFileSync } from "node:child_process";
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-cli-guard-eq-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "foo bar\nbaz\n");
  writeFileSync(join(dir, "b.txt"), "foo\n");
  writeFileSync(join(dir, "sub", "c.txt"), "nope\n");
  writeFileSync(join(dir, "sub", "d.log"), "foo log\n");
  writeFileSync(join(dir, "e.txt"), "a+\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(command: string): string {
  const stdout = execFileSync("sh", ["-c", command], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
  });
  return stdout.split("\n").filter((line) => line.length > 0).sort().join("\n");
}

/** Run the original and the rewritten command and assert identical stdout. */
function expectSame(original: string): void {
  const rewritten = rewriteCommand(original, enabled).command;
  expect(rewritten, `did not rewrite: ${original}`).not.toBe(original);
  expect(run(rewritten), `rewrite: ${rewritten}`).toBe(run(original));
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
    "grep -rn foo .",
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