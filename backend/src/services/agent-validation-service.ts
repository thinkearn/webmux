import type { ValidateCustomAgentResponse } from "@webmux/api-contract";
import { normalizeCustomAgentId } from "./agent-registry";

export function validateCustomAgentInput(input: {
  label: string;
  startCommand?: string;
  resumeCommand?: string;
  cliStyle?: "terminal" | "claude";
  claude?: {
    command: string;
    historyRoot: string;
    settingsDir: string;
  };
}): ValidateCustomAgentResponse {
  const warnings: string[] = [];

  if (input.cliStyle !== "claude") {
    const startCommand = input.startCommand ?? "";
    if (!startCommand.includes("${PROMPT}") && !startCommand.includes("${SYSTEM_PROMPT}")) {
      warnings.push("Start command does not reference ${PROMPT} or ${SYSTEM_PROMPT}; initial prompts will not be passed automatically");
    }

    if (!input.resumeCommand?.trim()) {
      warnings.push("Resume command is not configured; reopening the worktree will restart the agent");
    }
  }

  return {
    normalizedId: normalizeCustomAgentId(input.label),
    warnings,
  };
}
