import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { findExecutable, resolveBinary } from "./path.ts";

/** A fake filesystem: `path -> executable?` */
function fakeFs(files: Record<string, boolean>) {
  return {
    isFile: (path: string) => path in files,
    isExecutable: (path: string) => files[path] === true,
  };
}

describe("findExecutable", () => {
  it("finds a binary in the first matching PATH entry", () => {
    const fs = fakeFs({ "/a/rg": true, "/b/rg": true });
    expect(findExecutable({ names: ["rg"], pathEnv: "/a:/b", platform: "linux", ...fs })).toBe("/a/rg");
  });

  it("skips a non-executable file and keeps searching", () => {
    const fs = fakeFs({ "/a/rg": false, "/b/rg": true });
    expect(findExecutable({ names: ["rg"], pathEnv: "/a:/b", platform: "linux", ...fs })).toBe("/b/rg");
  });

  it("tries aliases in order", () => {
    const fs = fakeFs({ "/a/fdfind": true });
    expect(findExecutable({ names: ["fd", "fdfind"], pathEnv: "/a", platform: "linux", ...fs })).toBe("/a/fdfind");
  });

  it("returns undefined when nothing matches", () => {
    const fs = fakeFs({});
    expect(findExecutable({ names: ["rg"], pathEnv: "/a:/b", platform: "linux", ...fs })).toBeUndefined();
  });

  it("uses PATHEXT on Windows", () => {
    const fs = fakeFs({ "/a/rg.exe": true });
    expect(findExecutable({ names: ["rg"], pathEnv: "/a", platform: "win32", ...fs })).toBe("/a/rg.exe");
  });
});

describe("resolveBinary (real filesystem)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-guard-path-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function makeExecutable(name: string): void {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }

  it("returns the canonical name when found under it", () => {
    makeExecutable("fd");
    expect(resolveBinary({ binary: "fd", binaryAliases: ["fdfind"] }, { pathEnv: dir })).toBe("fd");
  });

  it("returns the alias name when only the alias exists", () => {
    makeExecutable("fdfind");
    expect(resolveBinary({ binary: "xx-fd-only", binaryAliases: ["fdfind"] }, { pathEnv: dir })).toBe("fdfind");
  });

  it("returns undefined when the binary is missing", () => {
    expect(resolveBinary({ binary: "nope" }, { pathEnv: dir })).toBeUndefined();
  });
});