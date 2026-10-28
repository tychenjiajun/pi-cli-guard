import { describe, expect, it } from "vitest";

import { translateFind } from "./find.ts";
import type { ArgToken } from "../shell.ts";
import { joinTokens } from "../shell.ts";

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
  const decision = translateFind(args);
  if (decision.kind === "rewrite") {
    return decision.args.length > 0 ? `${decision.name} ${joinTokens(decision.args)}` : decision.name!;
  }
  if (decision.kind === "refuse") return `REFUSE: ${decision.reason}`;
  return "noop";
}

describe("translateFind — notes", () => {
  function notes(args: ArgToken[]): string {
    const decision = translateFind(args);
    if (decision.kind !== "rewrite") throw new Error(`not a rewrite: ${decision.kind}`);
    return decision.notes.join("\n");
  }

  it("states the three fd differences a model can notice", () => {
    const text = notes(toks(".", "-name", '"*.py"'));
    expect(text).toContain("skips hidden");
    expect(text).toContain("trailing /");
    expect(text).toContain("never lists the search root");
  });

  it("states them for the -path form too", () => {
    const text = notes(toks(".", "-path", '"*sub*"', "-name", '"*.py"'));
    expect(text).toContain("never lists the search root");
  });
});

describe("translateFind — simple forms", () => {
  it("translates -name to a case-sensitive glob", () => {
    expect(render(toks(".", "-name", '"*.py"'))).toBe("fd -g -s '*.py' .");
  });

  it("translates -iname to a case-insensitive glob", () => {
    expect(render(toks(".", "-iname", '"*.py"'))).toBe("fd -g -i '*.py' .");
  });

  it("keeps an explicit path", () => {
    expect(render(toks("src", "-name", '"*.test.ts"'))).toBe("fd -g -s '*.test.ts' src");
  });

  it("maps -type f/d/l", () => {
    expect(render(toks(".", "-type", "f"))).toBe("fd -t f . .");
    expect(render(toks("src", "-type", "d"))).toBe("fd -t d . src");
    expect(render(toks(".", "-type", "l"))).toBe("fd -t l . .");
  });

  it("combines -type and -name", () => {
    expect(render(toks("src", "-type", "f", "-name", '"*.ts"'))).toBe("fd -t f -g -s '*.ts' src");
  });

  it("maps -maxdepth and -mindepth", () => {
    expect(render(toks("mlruns", "-maxdepth", "3"))).toBe("fd -d 3 . mlruns");
    expect(render(toks("mlruns", "-mindepth", "1"))).toBe("fd --min-depth 1 . mlruns");
  });

  it("joins -o name globs into one brace glob", () => {
    expect(render(toks(".", "-name", '"*.py"', "-o", "-name", '"*.ts"'))).toBe("fd -g -s '{*.py,*.ts}' .");
  });

  it("maps leading -L to follow symlinks and drops -H/-P", () => {
    expect(render(toks("-L", "src", "-name", "x"))).toBe("fd -L -g -s x src");
    expect(render(toks("-H", "src", "-name", "x"))).toBe("fd -g -s x src");
  });

  it("lists everything for a bare find", () => {
    expect(render(toks("."))).toBe("fd . .");
    expect(render(toks("src"))).toBe("fd . src");
  });
});

describe("translateFind — refusals", () => {
  it("refuses actions", () => {
    expect(render(toks(".", "-name", '"*.py"', "-delete"))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-exec", "rm", "{}", ";"))).toMatch(/^REFUSE/);
  });

  it("refuses boolean expressions other than -o between names", () => {
    expect(render(toks(".", "-type", "f", "-o", "-type", "d"))).toMatch(/^REFUSE/);
    expect(render(toks(".", "!", "-name", "x"))).toMatch(/^REFUSE/);
    // A group that actually carries `-o` has real precedence — refuse.
    expect(render(toks(".", "(", "-name", "x", "-o", "-name", "y", ")"))).toMatch(/^REFUSE/);
  });

  it("refuses -regex and other predicates", () => {
    expect(render(toks(".", "-regex", ".*x"))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-newer", "x"))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-perm", "644"))).toMatch(/^REFUSE/);
  });

  it("refuses implicit AND of two name globs", () => {
    expect(render(toks(".", "-name", "a", "-name", "b"))).toMatch(/^REFUSE/);
  });

  it("refuses a name glob containing a path separator", () => {
    expect(render(toks(".", "-name", '"src/*.ts"'))).toMatch(/^REFUSE/);
  });

  it("refuses mixing -name and -iname under -o", () => {
    expect(render(toks(".", "-name", "a", "-o", "-iname", "b"))).toMatch(/^REFUSE/);
  });

  it("refuses a non-integer depth", () => {
    expect(render(toks(".", "-maxdepth", "x"))).toMatch(/^REFUSE/);
  });

  it("refuses `-type` mixed with an -o name chain (find AND binds tighter than -o)", () => {
    // `(-type f -name a) -o (-name b)`: the type does not cover the second
    // branch, and one fd `-t` filter would wrongly apply to both.
    expect(render(toks(".", "-type", "f", "-name", '"*.ts"', "-o", "-name", '"*.tsx"'))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-name", '"*.ts"', "-o", "-name", '"*.tsx"', "-type", "f"))).toMatch(/^REFUSE/);
  });
});

describe("translateFind — grouping and -path", () => {
  it("drops redundant parentheses around a single test", () => {
    expect(render(toks(".", "-type", "f", "(", "-iname", '"*.arw"', ")"))).toBe(
      "fd -t f -g -i '*.arw' .",
    );
  });

  it("refuses a group that contains -o", () => {
    expect(render(toks(".", "(", "-name", "a", "-o", "-name", "b", ")"))).toMatch(/^REFUSE/);
  });

  it("maps an unanchored -path glob to a full-path regex", () => {
    expect(render(toks(".", "-path", '"*node_modules*"'))).toBe("fd -p -s '.*node_modules.*' .");
  });

  it("combines -path with -name via --and", () => {
    expect(render(toks(".", "-path", '"*/ffo/*"', "-name", '"*.py"'))).toBe(
      "fd -p -s '.*/ffo/.*' --and '(^|/)[^/]*\\.py$' .",
    );
  });

  it("combines -path with -type", () => {
    expect(render(toks("src", "-type", "f", "-path", '"*/gen/*"'))).toBe(
      "fd -t f -p -s '.*/gen/.*' src",
    );
  });

  it("translates ? and bracket classes inside a -path glob", () => {
    expect(render(toks(".", "-path", ["*src/[ab]?.ts", "*src/[ab]?.ts"]))).toBe(
      "fd -p -s '.*src/[ab].\\.ts' .",
    );
    expect(render(toks(".", "-path", ["*[!x]*", "*[!x]*"]))).toBe("fd -p -s '.*[^x].*' .");
  });

  it("refuses glob corners with no faithful regex form", () => {
    // A trailing lone backslash, and an escape inside a bracket expression.
    expect(render(toks(".", "-path", ["*x\\", "*x\\"]))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-path", ["*[a\\]x*", "*[a\\]x*"]))).toMatch(/^REFUSE/);
  });

  it("refuses an anchored -path glob (fd matches absolute paths)", () => {
    expect(render(toks(".", "-path", '"./src/*"'))).toMatch(/^REFUSE/);
  });

  it("refuses -path mixed with -iname or an -o chain", () => {
    expect(render(toks(".", "-path", '"*x*"', "-iname", '"*.py"'))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-path", '"*x*"', "-name", "a", "-o", "-name", "b"))).toMatch(/^REFUSE/);
  });
});

describe("translateFind — refusals where fd cannot match find", () => {
  it("refuses -maxdepth 0 (find lists the root, fd lists nothing)", () => {
    expect(render(toks(".", "-maxdepth", "0"))).toMatch(/^REFUSE: .*maxdepth 0/);
  });

  it("refuses a -name glob that can only match hidden entries", () => {
    // fd aborts with "The pattern(s) seems to only match files with a leading
    // dot" and exits 1, so the rewrite would turn results into an error.
    expect(render(toks(".", "-name", "'.*'"))).toMatch(/^REFUSE: .*hidden/);
    expect(render(toks(".", "-iname", "'.env*'"))).toMatch(/^REFUSE: .*hidden/);
    expect(render(toks(".", "-name", "'{.a,.b}'"))).toMatch(/^REFUSE: .*hidden/);
  });

  it("still translates globs that can match visible names", () => {
    expect(render(toks(".", "-name", "'*env'"))).toBe("fd -g -s '*env' .");
    expect(render(toks(".", "-name", "'{.a,*.b}'"))).toBe("fd -g -s '{.a,*.b}' .");
  });
});

describe("translateFind — refusals that stay refusals", () => {
  it("refuses -o name globs combined with -type", () => {
    expect(render(toks(".", "-type", "f", "-name", "a", "-o", "-name", "b"))).toMatch(/^REFUSE/);
  });

  it("refuses -not / !", () => {
    expect(render(toks(".", "!", "-path", '"*x*"'))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-not", "-name", "x"))).toMatch(/^REFUSE/);
  });

  it("refuses -exec and -delete", () => {
    expect(render(toks(".", "-name", "x", "-exec", "rm", "{}", ";"))).toMatch(/^REFUSE/);
    expect(render(toks(".", "-name", "x", "-delete"))).toMatch(/^REFUSE/);
  });
});

describe("translateFind — shapes found in real sessions", () => {
  it("translates the dominant `-type f -name GLOB` shape in either order", () => {
    expect(render(toks(".", "-type", "f", "-name", '"*.py"'))).toBe("fd -t f -g -s '*.py' .");
    expect(render(toks("src", "-name", '"*.ts"', "-type", "f"))).toBe("fd -t f -g -s '*.ts' src");
    expect(render(toks("plugins/PBTrade", "-name", '"*.spec.ts"', "-type", "f"))).toBe(
      "fd -t f -g -s '*.spec.ts' plugins/PBTrade",
    );
  });

  it("translates a directory-name lookup", () => {
    expect(render(toks(".", "-type", "d", "-name", "'__mocks__'"))).toBe("fd -t d -g -s __mocks__ .");
  });

  it("translates a substring glob", () => {
    expect(render(toks(".", "-name", "'*minute*'", "-type", "f"))).toBe("fd -t f -g -s '*minute*' .");
  });

  it("keeps -maxdepth/-mindepth global alongside an -o name chain", () => {
    // -maxdepth is a global option, unlike -type, so it applies to every branch.
    expect(render(toks(".", "-maxdepth", "2", "-name", "'*.md'", "-o", "-name", "'*.png'"))).toBe(
      "fd -d 2 -g -s '{*.md,*.png}' .",
    );
    expect(render(toks(".", "-mindepth", "1", "-maxdepth", "1", "-type", "d"))).toBe(
      "fd -d 1 --min-depth 1 -t d . .",
    );
  });

  it("still translates a pure -o name chain without a type test", () => {
    expect(render(toks(".", "-name", '"*.ts"', "-o", "-name", '"*.tsx"'))).toBe("fd -g -s '{*.ts,*.tsx}' .");
  });
});
