import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { CliGuardConfig } from "./config.ts";
import { registerCliGuard } from "./index.ts";
import { RULES } from "./rules.ts";

const config: CliGuardConfig = {
  enabled: [
    { rule: RULES["grep-to-rg"], binary: "rg" },
    { rule: RULES["find-to-fd"], binary: "fd" },
  ],
  notice: true,
};

interface Harness {
  readonly pi: ExtensionAPI;
  readonly handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
}

function harness(): Harness {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[event] ??= []).push(handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

const ctx = { mode: "print", hasUI: false, ui: { notify: () => {}, setStatus: () => {} } };

function callEvent(command: string, id = "c1") {
  return { type: "tool_call", toolName: "bash", toolCallId: id, input: { command } };
}

function resultEvent(id = "c1", extra: Record<string, unknown> = {}) {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: id,
    input: { command: "rg --with-filename -n foo ." },
    content: [{ type: "text", text: "foo" }],
    structuredContent: { output: "foo", truncated: false, exit_code: 0, wall_time_seconds: 0.1 },
    isError: false,
    details: {},
    ...extra,
  };
}

describe("cli guard extension", () => {
  it("rewrites the bash command in place", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    const event = callEvent("grep -rn foo .");
    await handlers.tool_call![0]!(event, ctx);
    expect((event.input as { command: string }).command).toBe("rg --with-filename -n foo .");
  });

  it("rewrites find to fd", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    const event = callEvent("find src -name '*.ts'");
    await handlers.tool_call![0]!(event, ctx);
    expect((event.input as { command: string }).command).toBe("fd -g -s '*.ts' src");
  });

  it("leaves refused commands untouched", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    const event = callEvent("grep 'a+' f");
    await handlers.tool_call![0]!(event, ctx);
    expect((event.input as { command: string }).command).toBe("grep 'a+' f");
  });

  it("ignores non-bash tools", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    const event = { type: "tool_call", toolName: "read", toolCallId: "c1", input: { path: "x" } };
    await handlers.tool_call![0]!(event, ctx);
    expect(event.input).toEqual({ path: "x" });
  });

  it("appends a notice and stamps the contract on the result", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    await handlers.tool_call![0]!(callEvent("grep -rn foo ."), ctx);
    const result = (await handlers.tool_result![0]!(resultEvent(), ctx)) as {
      content: { type: string; text: string }[];
      structuredContent: { output: string };
      details: { piCliGuard: { changes: { before: string; after: string }[] } };
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toContain("[pi-cli-guard]");
    expect(result.details.piCliGuard.changes[0]!.before).toBe("grep -rn foo .");
    expect(result.details.piCliGuard.changes[0]!.after).toBe("rg --with-filename -n foo .");
    // structuredContent is preserved alongside the replaced content.
    expect(result.structuredContent.output).toBe("foo");
  });

  it("does not append a notice when disabled", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, { ...config, notice: false });
    await handlers.tool_call![0]!(callEvent("grep -rn foo ."), ctx);
    const result = (await handlers.tool_result![0]!(resultEvent(), ctx)) as { content?: unknown };
    expect(result.content).toBeUndefined();
  });

  it("ignores a result with no pending rewrite", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    const result = await handlers.tool_result![0]!(resultEvent("unknown"), ctx);
    expect(result).toBeUndefined();
  });

  it("clears the pending record after the result", async () => {
    const { pi, handlers } = harness();
    registerCliGuard(pi, config);
    await handlers.tool_call![0]!(callEvent("grep -rn foo ."), ctx);
    await handlers.tool_result![0]!(resultEvent(), ctx);
    const again = await handlers.tool_result![0]!(resultEvent(), ctx);
    expect(again).toBeUndefined();
  });
});