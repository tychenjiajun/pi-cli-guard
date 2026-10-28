import { describe, expect, it } from "vitest";

import type { PiCliGuardDetails } from "./contract.ts";
import { buildNoticeText } from "./notice.ts";

const base = { version: 2, originalCommand: "x", command: "y" } as const;
const RG_SKIP = "ripgrep respects .gitignore and skips hidden files; add -u to search all";

describe("buildNoticeText", () => {
  it("lists a single change and the notes the rule attached to it", () => {
    const details: PiCliGuardDetails = {
      ...base,
      changes: [{ rule: "grep-to-rg", before: "grep x f", after: "rg x f", notes: ["grep→rg", RG_SKIP] }],
    };
    const text = buildNoticeText(details);
    expect(text).toContain("grep → rg (ripgrep)");
    expect(text).toContain("grep x f  →  rg x f");
    expect(text).toContain(RG_SKIP);
  });

  it("surfaces a note that contradicts the rule's usual scope", () => {
    // `--include` makes grep search ignored/hidden files, so the rewrite turns
    // ripgrep's ignore rules off; the model must be told that.
    const note = "grep --include searched hidden and .gitignore'd files too, so --hidden --no-ignore was passed";
    const text = buildNoticeText({
      ...base,
      changes: [
        {
          rule: "grep-to-rg",
          before: "grep --include='*.ts' x .",
          after: "rg -g '*.ts' --hidden --no-ignore x .",
          notes: ["grep→rg", note],
        },
      ],
    });
    expect(text).toContain(note);
    expect(text).not.toContain(RG_SKIP);
  });

  it("caps the listed changes and summarizes the rest", () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({
      rule: "grep-to-rg" as const,
      before: `grep ${i} f`,
      after: `rg ${i} f`,
      notes: ["grep→rg", RG_SKIP] as const,
    }));
    const text = buildNoticeText({ ...base, changes });
    expect(text).toContain("(+2 more; see details.piCliGuard)");
    const listed = text.split("\n").filter((line) => line.startsWith("  ") && line.includes("→"));
    expect(listed).toHaveLength(3);
  });

  it("appends a one-line hint when a command was refused", () => {
    const text = buildNoticeText({
      ...base,
      changes: [{ rule: "grep-to-rg", before: "grep x f", after: "rg x f", notes: ["grep→rg", RG_SKIP] }],
      refusals: [{ rule: "find-to-fd", before: "find . -delete", reason: "unsupported" }],
    });
    expect(text).toContain("Left 1 other command unchanged");
  });

  it("states a shared note once when several grep rules fire", () => {
    const text = buildNoticeText({
      ...base,
      changes: [
        { rule: "grep-to-rg", before: "grep x f", after: "rg x f", notes: ["grep→rg", RG_SKIP] },
        { rule: "egrep-to-rg", before: "egrep x f", after: "rg x f", notes: ["egrep→rg", RG_SKIP] },
      ],
    });
    expect(text.match(/respects \.gitignore/g)).toHaveLength(1);
    expect(text).toContain("grep → rg (ripgrep) · egrep → rg (ripgrep)");
  });
});
