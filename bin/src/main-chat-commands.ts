import { createApi } from "@webmux/api-contract";
import type { AgentId } from "../../backend/src/domain/config";
import { CommandUsageError, formatServerError } from "./shared";

export type MainChatSubcommand = "new" | "list" | "close" | "rm";

export interface ParsedMainChatNewCommand {
  subcommand: "new";
  agent: AgentId;
  prompt: string | null;
  profile: string | null;
}

export interface ParsedMainChatAgentCommand {
  subcommand: "close" | "rm";
  agent: AgentId;
}

export interface ParsedMainChatListCommand {
  subcommand: "list";
}

export type ParsedMainChatCommand =
  | ParsedMainChatNewCommand
  | ParsedMainChatAgentCommand
  | ParsedMainChatListCommand;

export function getMainChatUsage(subcommand?: MainChatSubcommand): string {
  if (subcommand === "new") {
    return [
      "Usage:",
      "  webmux chat new --agent <id> [--prompt <text>] [--profile <name>]",
      "",
      "Options:",
      "  --agent <id>             Agent id to launch (required)",
      "  --prompt <text>          Initial agent prompt",
      "  --profile <name>         Profile from .webmux.yaml",
      "  --help                   Show this help message",
    ].join("\n");
  }
  if (subcommand === "list") {
    return "Usage:\n  webmux chat list";
  }
  if (subcommand === "close") {
    return "Usage:\n  webmux chat close <agent-id>";
  }
  if (subcommand === "rm") {
    return "Usage:\n  webmux chat rm <agent-id>";
  }

  return [
    "Usage:",
    "  webmux chat new --agent <id> [--prompt <text>] [--profile <name>]",
    "  webmux chat list",
    "  webmux chat close <agent-id>",
    "  webmux chat rm <agent-id>",
    "",
    "Start an agent in the project root without creating a worktree.",
  ].join("\n");
}

function readOptionValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const arg = args[index];
  if (!arg) throw new CommandUsageError(`${flag} requires a value`);
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const value = args[index + 1];
  if (value === undefined) throw new CommandUsageError(`${flag} requires a value`);
  return { value, nextIndex: index + 1 };
}

export function parseMainChatArgs(args: string[]): ParsedMainChatCommand | null {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return null;
  }

  const subcommand = args[0];
  if (subcommand === "list") {
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!arg) continue;
      if (arg === "--help" || arg === "-h") return null;
      throw new CommandUsageError(`Unexpected argument: ${arg}`);
    }
    return { subcommand: "list" };
  }

  if (subcommand === "new") {
    let agent: AgentId | null = null;
    let prompt: string | null = null;
    let profile: string | null = null;

    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!arg) continue;
      if (arg === "--help" || arg === "-h") return null;

      if (arg === "--agent" || arg.startsWith("--agent=")) {
        const { value, nextIndex } = readOptionValue(args, index, "--agent");
        agent = value;
        index = nextIndex;
        continue;
      }
      if (arg === "--prompt" || arg.startsWith("--prompt=")) {
        const { value, nextIndex } = readOptionValue(args, index, "--prompt");
        prompt = value;
        index = nextIndex;
        continue;
      }
      if (arg === "--profile" || arg.startsWith("--profile=")) {
        const { value, nextIndex } = readOptionValue(args, index, "--profile");
        profile = value;
        index = nextIndex;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new CommandUsageError(`Unknown option: ${arg}`);
      }
      throw new CommandUsageError(`Unexpected argument: ${arg}`);
    }

    if (!agent) throw new CommandUsageError("chat new requires --agent <id>");
    return {
      subcommand: "new",
      agent,
      prompt,
      profile,
    };
  }

  if (subcommand === "close" || subcommand === "rm") {
    let agent: AgentId | null = null;
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!arg) continue;
      if (arg === "--help" || arg === "-h") return null;
      if (arg.startsWith("-")) throw new CommandUsageError(`Unknown option: ${arg}`);
      if (!agent) {
        agent = arg;
        continue;
      }
      throw new CommandUsageError(`Unexpected argument: ${arg}`);
    }
    if (!agent) throw new CommandUsageError(`chat ${subcommand} requires an <agent-id> argument`);
    return { subcommand, agent };
  }

  throw new CommandUsageError(`Unknown chat subcommand: ${subcommand}`);
}

function formatMainChatRow(chat: {
  id: string;
  agentId: string;
  agentLabel: string | null;
  mux: boolean;
  status: string;
}): string {
  const label = chat.agentLabel ?? chat.agentId;
  const session = chat.mux ? "open" : "closed";
  return `${label.padEnd(16)} ${session.padEnd(7)} ${chat.status.padEnd(10)} ${chat.id}`;
}

export async function runMainChatCommand(args: string[], port: number): Promise<number> {
  let parsed: ParsedMainChatCommand | null;
  try {
    parsed = parseMainChatArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(getMainChatUsage());
    return 1;
  }

  if (!parsed) {
    console.log(getMainChatUsage());
    return 0;
  }

  const api = createApi(`http://localhost:${port}`);
  try {
    if (parsed.subcommand === "list") {
      const response = await api.fetchMainChats();
      if (response.mainChats.length === 0) {
        console.log("No main chats.");
        return 0;
      }
      console.log(`${"AGENT".padEnd(16)} ${"SESSION".padEnd(7)} ${"STATUS".padEnd(10)} ID`);
      for (const chat of response.mainChats) {
        console.log(formatMainChatRow(chat));
      }
      return 0;
    }

    if (parsed.subcommand === "new") {
      const response = await api.createMainChat({
        agent: parsed.agent,
        ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
        ...(parsed.profile ? { profile: parsed.profile } : {}),
      });
      console.log(`Started main chat for ${response.mainChat.agentLabel ?? response.mainChat.agentId}`);
      console.log(`Chat id: ${response.mainChat.id}`);
      return 0;
    }

    if (parsed.subcommand === "close") {
      await api.closeMainChat({ params: { id: parsed.agent } });
      console.log(`Closed main chat for ${parsed.agent}`);
      return 0;
    }

    await api.removeMainChat({ params: { id: parsed.agent } });
    console.log(`Removed main chat for ${parsed.agent}`);
    return 0;
  } catch (error) {
    console.error(formatServerError(error, port));
    return 1;
  }
}
