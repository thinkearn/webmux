import { describe, expect, it } from "bun:test";
import { buildClaudeSessionFromText, encodeClaudeProjectDir } from "../adapters/claude-cli";

describe("claude-cli adapter", () => {
  it("encodes Claude project directories from cwd", () => {
    expect(encodeClaudeProjectDir("/tmp/worktrees/feature.one")).toBe("-tmp-worktrees-feature-one");
  });

  it("builds a transcript from Claude session jsonl text", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-1",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-14T15:00:00.000Z",
          cwd: "/tmp/worktrees/claude-feature",
          gitBranch: "claude-feature",
          message: {
            role: "user",
            content: "Inspect the failing tests\n",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-thinking",
          timestamp: "2026-04-14T15:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "text", text: "Let me inspect that." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-14T15:00:05.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "The failure comes from the stale snapshot." }],
          },
        }),
      ].join("\n"),
    });

    expect(session).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/worktrees/claude-feature",
      path: "/tmp/session.jsonl",
      gitBranch: "claude-feature",
      createdAt: "2026-04-14T15:00:00.000Z",
      lastSeenAt: "2026-04-14T15:00:05.000Z",
      messages: [
        {
          id: "user-1",
          turnId: "user-1",
          role: "user",
          kind: "text",
          text: "Inspect the failing tests",
          createdAt: "2026-04-14T15:00:00.000Z",
        },
        {
          id: "assistant-thinking:1",
          turnId: "user-1",
          role: "assistant",
          kind: "text",
          text: "Let me inspect that.",
          createdAt: "2026-04-14T15:00:01.000Z",
        },
        {
          id: "assistant-1:2",
          turnId: "user-1",
          role: "assistant",
          kind: "text",
          text: "The failure comes from the stale snapshot.",
          createdAt: "2026-04-14T15:00:05.000Z",
        },
      ],
    });
  });

  it("builds a transcript from CodeBuddy session jsonl text", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/codebuddy.jsonl",
      sessionId: "codebuddy-session",
      text: [
        JSON.stringify({
          id: "user-1",
          timestamp: 1780209814332,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "你好" }],
          sessionId: "codebuddy-session",
          cwd: "/tmp/worktrees/codebuddy-feature",
        }),
        JSON.stringify({
          id: "assistant-1",
          parentId: "user-1",
          timestamp: 1780209820378,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "你好，有什么我可以帮你处理的？" }],
          sessionId: "codebuddy-session",
          cwd: "/tmp/worktrees/codebuddy-feature",
        }),
      ].join("\n"),
    });

    expect(session.cwd).toBe("/tmp/worktrees/codebuddy-feature");
    expect(session.createdAt).toBe("2026-05-31T06:43:34.332Z");
    expect(session.lastSeenAt).toBe("2026-05-31T06:43:40.378Z");
    expect(session.messages).toEqual([
      {
        id: "user-1",
        turnId: "user-1",
        role: "user",
        kind: "text",
        text: "你好",
        createdAt: "2026-05-31T06:43:34.332Z",
      },
      {
        id: "assistant-1:1",
        turnId: "user-1",
        role: "assistant",
        kind: "text",
        text: "你好，有什么我可以帮你处理的？",
        createdAt: "2026-05-31T06:43:40.378Z",
      },
    ]);
  });

  it("surfaces tool_use and tool_result blocks as intermediate messages", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-2",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-14T15:00:00.000Z",
          cwd: "/tmp",
          message: { role: "user", content: "Read foo.txt" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-14T15:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Reading the file." },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/foo.txt" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "tool-result-1",
          timestamp: "2026-04-14T15:00:02.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "hello world" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-2",
          timestamp: "2026-04-14T15:00:03.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "It says hello world." }],
          },
        }),
      ].join("\n"),
    });

    expect(session.messages).toEqual([
      {
        id: "user-1",
        turnId: "user-1",
        role: "user",
        kind: "text",
        text: "Read foo.txt",
        createdAt: "2026-04-14T15:00:00.000Z",
      },
      {
        id: "assistant-1:1",
        turnId: "user-1",
        role: "assistant",
        kind: "text",
        text: "Reading the file.",
        createdAt: "2026-04-14T15:00:01.000Z",
      },
      {
        id: "assistant-1:2",
        turnId: "user-1",
        role: "assistant",
        kind: "toolUse",
        toolName: "Read",
        toolCallId: "tool-1",
        text: `{"file_path":"/tmp/foo.txt"}`,
        createdAt: "2026-04-14T15:00:01.000Z",
      },
      {
        id: "tool-result-1:3",
        turnId: "user-1",
        role: "user",
        kind: "toolResult",
        toolCallId: "tool-1",
        text: "hello world",
        createdAt: "2026-04-14T15:00:02.000Z",
      },
      {
        id: "assistant-2:4",
        turnId: "user-1",
        role: "assistant",
        kind: "text",
        text: "It says hello world.",
        createdAt: "2026-04-14T15:00:03.000Z",
      },
    ]);
  });

  it("surfaces thinking blocks from assistant records", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-thinking",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-14T16:00:00.000Z",
          cwd: "/tmp",
          message: { role: "user", content: "Explain this code" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-14T16:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [
              { type: "thinking", thinking: "Let me analyze the function step by step." },
              { type: "text", text: "This function does X." },
            ],
          },
        }),
      ].join("\n"),
    });

    expect(session.messages).toEqual([
      {
        id: "user-1",
        turnId: "user-1",
        role: "user",
        kind: "text",
        text: "Explain this code",
        createdAt: "2026-04-14T16:00:00.000Z",
      },
      {
        id: "assistant-1:1",
        turnId: "user-1",
        role: "assistant",
        kind: "thinking",
        text: "Let me analyze the function step by step.",
        createdAt: "2026-04-14T16:00:01.000Z",
      },
      {
        id: "assistant-1:2",
        turnId: "user-1",
        role: "assistant",
        kind: "text",
        text: "This function does X.",
        createdAt: "2026-04-14T16:00:01.000Z",
      },
    ]);
  });

  it("extracts command and cwd from Bash tool_use input", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-bash",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-14T17:00:00.000Z",
          cwd: "/repo",
          message: { role: "user", content: "Run the tests" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-14T17:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: "bun test", cwd: "/repo/src" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "tool-result-1",
          timestamp: "2026-04-14T17:00:02.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-bash-1", content: "all tests passed" },
            ],
          },
        }),
      ].join("\n"),
    });

    expect(session.messages).toEqual([
      {
        id: "user-1",
        turnId: "user-1",
        role: "user",
        kind: "text",
        text: "Run the tests",
        createdAt: "2026-04-14T17:00:00.000Z",
      },
      {
        id: "assistant-1:1",
        turnId: "user-1",
        role: "assistant",
        kind: "toolUse",
        toolName: "Bash",
        toolCallId: "tool-bash-1",
        command: "bun test",
        cwd: "/repo/src",
        text: '{"command":"bun test","cwd":"/repo/src"}',
        createdAt: "2026-04-14T17:00:01.000Z",
      },
      {
        id: "tool-result-1:2",
        turnId: "user-1",
        role: "user",
        kind: "toolResult",
        toolCallId: "tool-bash-1",
        text: "all tests passed",
        createdAt: "2026-04-14T17:00:02.000Z",
      },
    ]);
  });
});
