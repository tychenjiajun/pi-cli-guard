import { describe, expect, it } from "vitest";

import type { PiCliGuardDetails } from "./contract.ts";
import { buildNoticeText } from "./notice.ts";

const base = { version: 1, originalCommand: "x", command: "y" } as const;

describe("buildNoticeText", () => {
  it("lists a single change and its guidance", () => {
    const details: PiCliGuardDetails = {
      ...base,
      changes: [{ rule: "grep-to-rg", before: "grep x f", after: "rg x f" }],
    };
    const text = buildNoticeText(details);
    expect(text).toContain("grep → rg (ripgrep)");
    expect(text).toContain("grep x f  →  rg x f");
    expect(text).toContain("rg respects .gitignore");
  });

  it("caps the listed changes and summarizes the rest", () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({
      rule: "grep-to-rg" as const,
      before: `grep ${i} f`,
      after: `rg ${i} f`,
    }));
    const text = buildNoticeText({ ...base, changes });
    expect(text).toContain("(+2 more; see details.piCliGuard)");
    const listed = text.split("\n").filter((line) => line.startsWith("  ") && line.includes("→"));
    expect(listed).toHaveLength(3);
  });

  it("appends a one-line hint when a command was refused", () => {
    const text = buildNoticeText({
      ...base,
      changes: [{ rule: "grep-to-rg", before: "grep x f", after: "rg x f" }],
      refusals: [{ rule: "find-to-fd", before: "find . -delete", reason: "unsupported" }],
    });
    expect(text).toContain("Left 1 other command unchanged");
  });

  it("states the rg caveat once when several grep rules fire", () => {
    const text = buildNoticeText({
      ...base,
      changes: [
        { rule: "grep-to-rg", before: "grep x f", after: "rg x f" },
        { rule: "egrep-to-rg", before: "egrep x f", after: "rg x f" },
      ],
    });
    expect(text.match(/respects \.gitignore/g)).toHaveLength(1);
  });
});