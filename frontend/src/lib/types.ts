import type {
  AgentId,
  AgentsUiApprovalPrompt,
  BuiltInAgentId,
  LinkedLinearIssue,
  OneshotConfig,
  PrEntry,
  ServiceStatus,
  WorktreeCreationPhase,
  WorktreeSource,
} from "@webmux/api-contract";

export type {
  AgentsUiApprovalPrompt,
  AgentsUiConversationEvent,
  AgentsUiConversationMessage,
  AgentsUiConversationMessageDeltaEvent,
  AgentsUiConversationMessageUpsertEvent,
  AgentsUiConversationStatusEvent,
  AgentsUiConversationState,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AgentCapabilities,
  AgentDetails,
  AgentId,
  AgentKind,
  CustomAgentCliStyle,
  CustomAgentClaudeConfig,
  BuiltInAgentId,
  AgentListResponse,
  AgentResponse,
  AgentSummary,
  ValidateCustomAgentResponse,
  AppConfig,
  AppNotification,
  AvailableBranch,
  AvailableBranchesQuery,
  BranchListResponse,
  CiCheck,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  CreateMainChatRequest,
  MainChatSnapshot,
  LinearIssue,
  LinearIssueAvailability,
  LinearIssueLabel,
  LinearIssueState,
  LinearIssuesResponse,
  LinkedLinearIssue,
  LinkedRepoInfo,
  OneshotConfig,
  PostWorktreeToLinearRequest,
  PostWorktreeToLinearResponse,
  PostWorktreeToLinearTarget,
  FromLinearInput,
  InstanceSummary,
  PrComment,
  PrEntry,
  ProfileConfig,
  ProjectSnapshot,
  ProjectWorktreeSnapshot,
  PullMainResult,
  ServiceConfig,
  UpsertCustomAgentRequest,
  ServiceStatus,
  SetWorktreeArchivedRequest,
  SetWorktreeArchivedResponse,
  SetWorktreeLabelRequest,
  SetWorktreeLabelResponse,
  UnpushedCommit,
  WorktreeCreationPhase,
  WorktreeCreationState,
  WorktreeCreateMode,
  WorktreeDiffResponse,
  WorktreeListResponse,
  WorktreeSource,
} from "@webmux/api-contract";
export type { AgentsSendMessageRequest as AgentsUiSendMessageRequest } from "@webmux/api-contract";

export type SidebarItemKind = "worktree" | "mainChat";

export interface FileUploadResult {
  files: Array<{ path: string }>;
}

export interface DiffDialogProps {
  branch: string;
  cursorUrl?: string | null;
  onclose: () => void;
}

export interface WorktreeInfo {
  branch: string;
  kind?: SidebarItemKind;
  label: string | null;
  baseBranch?: string;
  archived: boolean;
  agent: string;
  mux: string;
  path: string;
  dir: string | null;
  dirty: boolean;
  unpushed: boolean;
  status: string;
  elapsed: string;
  approvalPrompt: AgentsUiApprovalPrompt | null;
  profile: string | null;
  agentName: AgentId | null;
  agentLabel: string | null;
  agentTerminalStale: boolean;
  services: ServiceStatus[];
  paneCount: number;
  prs: PrEntry[];
  linearIssue: LinkedLinearIssue | null;
  creating: boolean;
  creationPhase: WorktreeCreationPhase | null;
  source: WorktreeSource;
  oneshot: OneshotConfig | null;
}

export interface WorktreeListRow {
  worktree: WorktreeInfo;
  depth: number;
}

export interface TmuxLayoutWindow {
  name: string;
  paneCount: number;
  active: boolean;
}

export interface TmuxLayoutSnapshot {
  sessionName: string;
  currentWindow: string;
  windows: TmuxLayoutWindow[];
  panes: number[];
  activePane: number;
}

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  tone: ToastTone;
  message: string;
  detail?: string;
}

export interface UiToastItem extends ToastInput {
  id: string;
  source: "ui";
}

export interface NotificationToastItem extends ToastInput {
  id: string;
  source: "notification";
  notificationId: number;
  branch: string;
}

export type ToastItem = UiToastItem | NotificationToastItem;
