import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveConfig } from "./config.ts";
import { parseRuleIds, RULE_IDS } from "./rules.ts";

describe("parseRuleIds", () => {
  it("defaults to every rule", () => {
    expect(parseRuleIds(undefined)).toEqual(new Set(RULE_IDS));
  });

  it("accepts ids and short names", () => {
    expect(parseRuleIds("grep-to-rg")).toEqual(new Set(["grep-to-rg"]));
    expect(parseRuleIds("rg,find-to-fd")).toEqual(new Set(["grep-to-rg", "find-to-fd"]));
  });

  it("ignores unknown entries", () => {
    expect(parseRuleIds("rg,unknown")).toEqual(new Set(["grep-to-rg"]));
  });
});

describe("resolveConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-guard-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function makeExecutable(name: string): void {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }

  it("enables rules whose binaries resolve", () => {
    makeExecutable("rg");
    makeExecutable("fd");
    const config = resolveConfig({ PATH: dir });
    expect(config.enabled.map((e) => e.rule.id)).toEqual(["grep-to-rg", "find-to-fd"]);
    expect(config.enabled.map((e) => e.binary)).toEqual(["rg", "fd"]);
    expect(config.notice).toBe(true);
  });

  it("skips rules whose binary is missing", () => {
    const config = resolveConfig({ PATH: "/definitely/not/here" });
    expect(config.enabled).toEqual([]);
  });

  it("honours PI_CLI_GUARD=off", () => {
    const config = resolveConfig({ PATH: dir, PI_CLI_GUARD: "off" });
    expect(config.enabled).toEqual([]);
    expect(config.notice).toBe(false);
  });

  it("honours PI_CLI_GUARD_RULES", () => {
    makeExecutable("rg");
    const config = resolveConfig({ PATH: dir, PI_CLI_GUARD_RULES: "rg" });
    expect(config.enabled.map((e) => e.rule.id)).toEqual(["grep-to-rg"]);
  });

  it("honours PI_CLI_GUARD_NOTICE=off", () => {
    makeExecutable("rg");
    const config = resolveConfig({ PATH: dir, PI_CLI_GUARD_NOTICE: "off" });
    expect(config.notice).toBe(false);
  });
});