import { CUSTOM_AGENT_DEFAULTS } from "@webmux/api-contract";
import type { CustomAgentClaudeConfig } from "../domain/config";
import type { AgentDefinition } from "./agent-registry";

export interface AgentChatSupport {
  provider: "claude" | "codex";
  submitDelayMs: number;
  claude?: CustomAgentClaudeConfig;
}

const CODEX_SUBMIT_DELAY_MS = 200;

export function resolveAgentTerminalSubmitDelayMs(input: {
  agentId: string | null;
  agent: AgentDefinition | null;
}): number {
  if (!input.agentId || !input.agent || input.agent.kind !== "builtin") return 0;
  return input.agent.implementation.agent === "codex" ? CODEX_SUBMIT_DELAY_MS : 0;
}

export function resolveAgentChatSupport(input: {
  agentId: string | null;
  agentLabel: string | null;
  agent: AgentDefinition | null;
  action: "chat" | "interrupt";
}):
  | { ok: true; data: AgentChatSupport }
  | { ok: false; error: string; status: number } {
  if (!input.agentId) {
    return {
      ok: false,
      error: "This worktree has no agent configured",
      status: 409,
    };
  }

  if (!input.agent) {
    return {
      ok: false,
      error: `Unknown agent: ${input.agentId}`,
      status: 404,
    };
  }

  const agentLabel = input.agentLabel ?? input.agent.label;
  if (!input.agent.capabilities.inAppChat || !input.agent.capabilities.conversationHistory) {
    return {
      ok: false,
      error: `${agentLabel} does not support in-app chat`,
      status: 409,
    };
  }

  if (input.action === "interrupt" && !input.agent.capabilities.interrupt) {
    return {
      ok: false,
      error: `${agentLabel} cannot be interrupted from the dashboard`,
      status: 409,
    };
  }

  if (input.agent.kind === "builtin") {
    if (input.agent.implementation.agent === "codebuddy") {
      return {
        ok: true,
        data: {
          provider: "claude",
          submitDelayMs: 0,
          claude: {
            command: "codebuddy",
            historyRoot: "~/.codebuddy/projects",
            settingsDir: ".codebuddy",
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        provider: input.agent.implementation.agent,
        submitDelayMs: resolveAgentTerminalSubmitDelayMs(input),
      },
    };
  }

  if (input.agent.kind === "custom" && input.agent.implementation.config.cliStyle === "claude") {
    return {
      ok: true,
      data: {
        provider: "claude",
        submitDelayMs: 0,
        claude: input.agent.implementation.config.claude ?? { ...CUSTOM_AGENT_DEFAULTS.claude },
      },
    };
  }

  return {
    ok: false,
    error: `Dashboard chat is not available for ${agentLabel}`,
    status: 409,
  };
}
