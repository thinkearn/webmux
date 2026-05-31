import { describe, expect, test } from "bun:test";
import { getMainChatUsage, parseMainChatArgs } from "./main-chat-commands";

describe("parseMainChatArgs", () => {
  test("returns null for empty args", () => {
    expect(parseMainChatArgs([])).toBeNull();
  });

  test("parses chat new", () => {
    expect(parseMainChatArgs(["new", "--agent", "claude", "--prompt", "hello"])).toEqual({
      subcommand: "new",
      agent: "claude",
      prompt: "hello",
      profile: null,
    });
  });

  test("parses chat list", () => {
    expect(parseMainChatArgs(["list"])).toEqual({ subcommand: "list" });
  });

  test("parses chat close", () => {
    expect(parseMainChatArgs(["close", "codex"])).toEqual({
      subcommand: "close",
      agent: "codex",
    });
  });

  test("parses chat rm", () => {
    expect(parseMainChatArgs(["rm", "claude"])).toEqual({
      subcommand: "rm",
      agent: "claude",
    });
  });
});

describe("getMainChatUsage", () => {
  test("includes subcommands", () => {
    expect(getMainChatUsage()).toContain("webmux chat new");
    expect(getMainChatUsage("close")).toContain("webmux chat close");
  });
});
