import { describe, expect, it, vi } from "vitest";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("unbash", () => ({ parse }));

import { rewriteCommand, type EnabledRule } from "./engine.ts";
import { RULES } from "./rules.ts";

const enabled: EnabledRule[] = [
  { rule: RULES["grep-to-rg"], binary: "rg" },
  { rule: RULES["find-to-fd"], binary: "fd" },
];

describe("rewriteCommand — parse fast path", () => {
  it("skips unbash for a command without any legacy tool name", () => {
    parse.mockReset();
    const result = rewriteCommand("git status --short && ls -la", enabled);
    expect(result.command).toBe("git status --short && ls -la");
    expect(result.changes).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("parses when an enabled command name appears", () => {
    parse.mockReset();
    parse.mockReturnValue({ commands: [] });
    rewriteCommand("grep -n foo f", enabled);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});