import { describe, expect, it } from "vitest";

import { joinTokens, rawToken, shellQuote, token } from "./shell.ts";

describe("shellQuote", () => {
  it("leaves bare words alone", () => {
    expect(shellQuote("foo")).toBe("foo");
    expect(shellQuote("-n")).toBe("-n");
    expect(shellQuote("--min-depth")).toBe("--min-depth");
    expect(shellQuote("./a/b")).toBe("./a/b");
  });

  it("quotes globs and braces so the shell cannot expand them", () => {
    expect(shellQuote("*.py")).toBe("'*.py'");
    expect(shellQuote("{*.py,*.ts}")).toBe("'{*.py,*.ts}'");
    expect(shellQuote("!node_modules/**")).toBe("'!node_modules/**'");
  });

  it("quotes spaces and embedded single quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("token helpers", () => {
  it("token quotes the value when needed", () => {
    expect(token("*.py").text).toBe("'*.py'");
    expect(token("fd").text).toBe("fd");
  });

  it("rawToken preserves the given text", () => {
    expect(rawToken("*.py", "*.py").text).toBe("*.py");
  });

  it("joinTokens separates with single spaces", () => {
    expect(joinTokens([token("-n"), rawToken("'a|b'", "a|b"), token(".")])).toBe("-n 'a|b' .");
  });
});