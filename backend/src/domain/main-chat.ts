import type { AgentId, RuntimeKind } from "./config";
import type { AgentApprovalPrompt, WorktreeConversationMeta } from "./model";

export const MAIN_CHAT_META_SCHEMA_VERSION = 1;
export const MAIN_CHAT_ID_PREFIX = "main-chat:";

export interface MainChatMeta {
  schemaVersion: number;
  chatId: string;
  worktreeId: string;
  agent: AgentId;
  profile: string;
  runtime: RuntimeKind;
  createdAt: string;
  startupEnvValues: Record<string, string>;
  allocatedPorts: Record<string, number>;
  conversation?: WorktreeConversationMeta | null;
}

export interface MainChatSnapshot {
  id: string;
  agentId: AgentId;
  agentLabel: string | null;
  profile: string | null;
  path: string;
  mux: boolean;
  status: string;
  elapsed: string;
  approvalPrompt: AgentApprovalPrompt | null;
  paneCount: number;
}

export function buildMainChatId(agentId: AgentId): string {
  return `${MAIN_CHAT_ID_PREFIX}${agentId}`;
}

export function parseMainChatId(id: string): AgentId | null {
  if (!id.startsWith(MAIN_CHAT_ID_PREFIX)) return null;
  const agentId = id.slice(MAIN_CHAT_ID_PREFIX.length).trim();
  return agentId.length > 0 ? agentId : null;
}

export function buildMainChatBranchName(agentId: AgentId): string {
  return `main-chat-${agentId}`;
}

export interface MainChatRuntimeState {
  chatId: string;
  agentId: AgentId;
  profile: string | null;
  path: string;
  createdAt: string;
  session: {
    exists: boolean;
    sessionName: string | null;
    paneCount: number;
  };
  agent: {
    lifecycle: import("./model").AgentLifecycle;
    lastStartedAt: string | null;
    lastEventAt: string | null;
    lastError: string | null;
    approvalPrompt: import("./model").AgentApprovalPrompt | null;
  };
}
