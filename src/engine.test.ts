import { describe, expect, it } from "vitest";

import { rewriteCommand, type EnabledRule } from "./engine.ts";
import { RULES } from "./rules.ts";

const enabled: EnabledRule[] = [
  { rule: RULES["grep-to-rg"], binary: "rg" },
  { rule: RULES["find-to-fd"], binary: "fd" },
];

const rw = (command: string, rules: EnabledRule[] = enabled): string => rewriteCommand(command, rules).command;

describe("rewriteCommand — placement", () => {
  it("rewrites a middle-of-pipeline grep", () => {
    expect(rw("cat f | grep -n x | head -3")).toBe("cat f | rg -n x | head -3");
  });

  it("rewrites a command inside an AndOr chain", () => {
    expect(rw("cd src && grep -rn foo .")).toBe("cd src && rg --with-filename -n foo .");
  });

  it("rewrites a command inside an if", () => {
    expect(rw("if grep -q x f; then echo y; fi")).toBe("if rg -q x f; then echo y; fi");
  });

  it("rewrites several commands in one script", () => {
    expect(rw("grep a f; grep b g")).toBe("rg a f; rg b g");
  });

  it("keeps environment-assignment prefixes", () => {
    expect(rw("LC_ALL=C grep -n foo .")).toBe("LC_ALL=C rg -n foo .");
  });

  it("preserves a trailing redirect", () => {
    expect(rw("grep -n foo . > out")).toBe("rg -n foo . > out");
  });

  it("rewrites find with a path", () => {
    expect(rw("find src -name '*.ts' -type f")).toBe("fd -t f -g -s '*.ts' src");
  });

  it("rewrites a find and a piped grep in one command", () => {
    expect(rw("find . -type f -name '*.py' | grep -i market")).toBe("fd -t f -g -s '*.py' . | rg -i market");
  });

  it("rewrites a BRE alternation and is idempotent", () => {
    expect(rw("grep -rn 'FAIL\\|Test Files' .")).toBe("rg --with-filename -n 'FAIL|Test Files' .");
    expect(rw("rg --with-filename -n 'FAIL|Test Files' .")).toBe("rg --with-filename -n 'FAIL|Test Files' .");
  });
});

describe("rewriteCommand — safety", () => {
  it("leaves a refused grep untouched", () => {
    expect(rw("grep 'a+' f")).toBe("grep 'a+' f");
  });

  it("does not descend into command substitutions", () => {
    expect(rw('echo "$(grep x f)"')).toBe('echo "$(grep x f)"');
  });

  it("leaves a command with an interleaved redirect untouched", () => {
    expect(rw("grep 2>/dev/null foo")).toBe("grep 2>/dev/null foo");
  });

  it("preserves a redirect after the find arguments", () => {
    expect(rw("find . -type f 2>/dev/null")).toBe("fd -t f . . 2>/dev/null");
  });

  it("leaves a refused find untouched even inside a pipeline", () => {
    expect(rw("find . -type f -name '*.ts' -o -name '*.tsx' | head -20")).toBe(
      "find . -type f -name '*.ts' -o -name '*.tsx' | head -20",
    );
  });

  it("does not descend into command substitutions (find)", () => {
    expect(rw("npx vitest run $(find src -name '*.spec.ts' -type f | head -30)")).toBe(
      "npx vitest run $(find src -name '*.spec.ts' -type f | head -30)",
    );
  });

  it("is idempotent", () => {
    expect(rw("grep -rn foo .")).toBe("rg --with-filename -n foo .");
    expect(rw("rg -n foo .")).toBe("rg -n foo .");
    expect(rw("fd -g -s '*.py' .")).toBe("fd -g -s '*.py' .");
  });
});

describe("rewriteCommand — reporting", () => {
  it("records before/after and notes", () => {
    const result = rewriteCommand("grep -rn foo .", enabled);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.rule).toBe("grep-to-rg");
    expect(result.changes[0]!.before).toBe("grep -rn foo .");
    expect(result.changes[0]!.after).toBe("rg --with-filename -n foo .");
    expect(result.changes[0]!.notes.length).toBeGreaterThan(0);
  });

  it("records refusals without changing the command", () => {
    const result = rewriteCommand("grep 'a+' f", enabled);
    expect(result.command).toBe("grep 'a+' f");
    expect(result.changes).toHaveLength(0);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.rule).toBe("grep-to-rg");
  });

  it("leaves a bare `grep` alone (rg without a pattern searches cwd)", () => {
    expect(rw("grep")).toBe("grep");
  });

  it("does nothing with no enabled rules", () => {
    expect(rw("grep -rn foo .", [])).toBe("grep -rn foo .");
  });
});