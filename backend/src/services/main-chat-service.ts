import { ensureAgentRuntimeArtifacts } from "../adapters/agent-runtime";
import {
  buildControlEnvMap,
  buildMainChatMeta,
  buildRuntimeEnvMap,
  ensureMainChatStorageDirs,
  listMainChatAgentIds,
  loadDotenvLocal,
  mainChatMetaAsWorktreeMeta,
  readMainChatMeta,
  removeMainChatStorage,
  writeMainChatControlEnv,
  writeMainChatMeta,
  writeMainChatRuntimeEnv,
} from "../adapters/fs";
import { getDefaultProfileName, type ProjectConfig } from "../adapters/config";
import type { GitGateway } from "../adapters/git";
import {
  buildProjectSessionName,
  buildWorktreeWindowName,
  type TmuxGateway,
} from "../adapters/tmux";
import type { AgentId } from "../domain/config";
import {
  buildMainChatBranchName,
  buildMainChatId,
  type MainChatMeta,
  type MainChatSnapshot,
} from "../domain/main-chat";
import { allocateServicePorts } from "../domain/policies";
import { buildAgentPaneCommand, buildManagedShellCommand } from "./agent-service";
import { getAgentDefinition, type AgentDefinition } from "./agent-registry";
import { LifecycleError } from "./lifecycle-service";
import type { ProjectRuntime } from "./project-runtime";
import { ensureSessionLayout, planSessionLayout } from "./session-service";
import type { ReconciliationService } from "./reconciliation-service";

export interface MainChatServiceDependencies {
  projectRoot: string;
  projectGitDir: string;
  mainBranch: string;
  controlBaseUrl: string;
  getControlToken: () => Promise<string>;
  config: ProjectConfig;
  git: Pick<GitGateway, "resolveWorktreeGitDir">;
  tmux: TmuxGateway;
  runtime: ProjectRuntime;
  reconciliation: ReconciliationService;
}

export interface CreateMainChatInput {
  agent: AgentId;
  profile?: string;
  prompt?: string;
}

function formatElapsedSince(startedAt: string | null, now: () => Date): string {
  if (!startedAt) return "";
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return "";

  const diffMs = Math.max(0, now().getTime() - startedMs);
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "0m";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;

  return `${Math.floor(diffHours / 24)}d`;
}

function buildRuntimeControlBaseUrl(controlBaseUrl: string): string {
  return controlBaseUrl.replace(/\/+$/, "");
}

function controlUrl(controlBaseUrl: string): string {
  return `${buildRuntimeControlBaseUrl(controlBaseUrl)}/api/runtime/events`;
}

async function readExistingMainChatMetas(projectGitDir: string): Promise<MainChatMeta[]> {
  const agentIds = await listMainChatAgentIds(projectGitDir);
  const metas = await Promise.all(agentIds.map((agentId) => readMainChatMeta(projectGitDir, agentId)));
  return metas.filter((meta): meta is MainChatMeta => meta !== null);
}

export class MainChatService {
  constructor(private readonly deps: MainChatServiceDependencies) {}

  async listSnapshots(now: () => Date = () => new Date()): Promise<MainChatSnapshot[]> {
    await this.reconcile();
    return this.deps.runtime.listMainChats().map((state) => this.mapRuntimeState(state, now));
  }

  async createMainChat(input: CreateMainChatInput): Promise<MainChatSnapshot> {
    const agent = this.resolveAgentDefinition(input.agent);
    const existing = await readMainChatMeta(this.deps.projectGitDir, agent.id);
    if (existing) {
      throw new LifecycleError(`Main chat already exists for agent: ${agent.id}`, 409);
    }

    const { profileName, profile } = this.resolveProfile(input.profile);
    if (profile.runtime === "docker") {
      throw new LifecycleError("Main chat is only supported for host profiles", 400);
    }

    const chatId = buildMainChatId(agent.id);
    const branchName = buildMainChatBranchName(agent.id);
    const metas = await readExistingMainChatMetas(this.deps.projectGitDir);
    const allocatedPorts = allocateServicePorts(
      metas.map((meta) => mainChatMetaAsWorktreeMeta(meta, this.deps.mainBranch)),
      this.deps.config.services,
    );
    const startupEnvValues = Object.fromEntries(
      Object.entries(this.deps.config.startupEnvs).map(([key, value]) => [
        key,
        typeof value === "boolean" ? String(value) : value,
      ]),
    );
    const dotenvValues = await loadDotenvLocal(this.deps.projectRoot);
    const meta = buildMainChatMeta({
      chatId,
      worktreeId: chatId,
      agent: agent.id,
      profile: profileName,
      runtime: profile.runtime,
      startupEnvValues,
      allocatedPorts,
    });
    await writeMainChatMeta(this.deps.projectGitDir, meta);

    const worktreeMeta = mainChatMetaAsWorktreeMeta(meta, this.deps.mainBranch);
    const runtimeEnv = buildRuntimeEnvMap(worktreeMeta, {
      WEBMUX_WORKTREE_PATH: this.deps.projectRoot,
    }, dotenvValues);
    await writeMainChatRuntimeEnv(this.deps.projectGitDir, agent.id, runtimeEnv);
    await writeMainChatControlEnv(this.deps.projectGitDir, agent.id, buildControlEnvMap({
      controlUrl: controlUrl(this.deps.controlBaseUrl),
      controlToken: await this.deps.getControlToken(),
      worktreeId: meta.worktreeId,
      branch: chatId,
    }));

    const { runtimeEnvPath } = await ensureMainChatStorageDirs(this.deps.projectGitDir, agent.id);

    await ensureAgentRuntimeArtifacts({
      gitDir: this.deps.projectGitDir,
      worktreePath: this.deps.projectRoot,
      settingsDirs: agent.kind === "custom" && agent.implementation.config.cliStyle === "claude" && agent.implementation.config.claude
        ? [agent.implementation.config.claude.settingsDir]
        : [],
    });

    const sessionPlan = planSessionLayout(
      this.deps.projectRoot,
      branchName,
      profile.panes.filter((pane) => pane.kind === "agent"),
      {
        repoRoot: this.deps.projectRoot,
        worktreePath: this.deps.projectRoot,
        paneCommands: {
          agent: buildAgentPaneCommand({
            agent,
            runtimeEnvPath: runtimeEnvPath,
            repoRoot: this.deps.projectRoot,
            worktreePath: this.deps.projectRoot,
            branch: this.deps.mainBranch,
            profileName,
            yolo: profile.yolo === true,
            systemPrompt: profile.systemPrompt,
            prompt: input.prompt,
            launchMode: "fresh",
          }),
          shell: buildManagedShellCommand(runtimeEnvPath),
        },
      },
    );

    ensureSessionLayout(this.deps.tmux, sessionPlan);
    await this.reconcile(true);
    const snapshot = this.deps.runtime.getMainChatByAgent(agent.id);
    if (!snapshot) {
      throw new LifecycleError(`Main chat could not be loaded after creation: ${agent.id}`, 500);
    }
    return this.mapRuntimeState(snapshot, () => new Date());
  }

  async closeMainChat(agentId: AgentId): Promise<void> {
    const meta = await this.requireMainChatMeta(agentId);
    this.deps.tmux.killWindow(
      buildProjectSessionName(this.deps.projectRoot),
      buildWorktreeWindowName(buildMainChatBranchName(meta.agent)),
    );
    await this.reconcile(true);
  }

  async removeMainChat(agentId: AgentId): Promise<void> {
    const meta = await this.requireMainChatMeta(agentId);
    this.deps.tmux.killWindow(
      buildProjectSessionName(this.deps.projectRoot),
      buildWorktreeWindowName(buildMainChatBranchName(meta.agent)),
    );
    await removeMainChatStorage(this.deps.projectGitDir, meta.agent);
    this.deps.runtime.removeMainChat(meta.chatId);
    await this.reconcile(true);
  }

  async reconcile(force = false): Promise<void> {
    const sessionName = buildProjectSessionName(this.deps.projectRoot);
    let windows: Array<{ sessionName: string; windowName: string; paneCount: number }> = [];
    try {
      windows = this.deps.tmux.listWindows();
    } catch {
      windows = [];
    }

    const seenChatIds = new Set<string>();
    const metas = await readExistingMainChatMetas(this.deps.projectGitDir);

    for (const meta of metas) {
      const branchName = buildMainChatBranchName(meta.agent);
      const windowName = buildWorktreeWindowName(branchName);
      const window = windows.find((entry) => entry.sessionName === sessionName && entry.windowName === windowName) ?? null;
      seenChatIds.add(meta.chatId);

      this.deps.runtime.upsertMainChat({
        chatId: meta.chatId,
        agentId: meta.agent,
        profile: meta.profile,
        path: this.deps.projectRoot,
        createdAt: meta.createdAt,
      });
      this.deps.runtime.setMainChatSessionState(meta.chatId, {
        exists: window !== null,
        sessionName: window?.sessionName ?? null,
        paneCount: window?.paneCount ?? 0,
      });
    }

    for (const state of this.deps.runtime.listMainChats()) {
      if (!seenChatIds.has(state.chatId)) {
        this.deps.runtime.removeMainChat(state.chatId);
      }
    }

    if (force) {
      await this.deps.reconciliation.reconcile(this.deps.projectRoot, { force: true });
    }
  }

  async getMainChatSnapshot(agentId: AgentId): Promise<MainChatSnapshot | null> {
    await this.reconcile();
    const state = this.deps.runtime.getMainChatByAgent(agentId);
    return state ? this.mapRuntimeState(state, () => new Date()) : null;
  }

  async requireMainChatSnapshot(agentId: AgentId): Promise<MainChatSnapshot> {
    const snapshot = await this.getMainChatSnapshot(agentId);
    if (!snapshot) {
      throw new LifecycleError(`Main chat not found for agent: ${agentId}`, 404);
    }
    return snapshot;
  }

  private async requireMainChatMeta(agentId: AgentId): Promise<MainChatMeta> {
    const meta = await readMainChatMeta(this.deps.projectGitDir, agentId);
    if (!meta) {
      throw new LifecycleError(`Main chat not found for agent: ${agentId}`, 404);
    }
    return meta;
  }

  private resolveProfile(profileName: string | undefined): {
    profileName: string;
    profile: ProjectConfig["profiles"][string];
  } {
    const name = profileName ?? getDefaultProfileName(this.deps.config);
    const profile = this.deps.config.profiles[name];
    if (!profile) {
      throw new LifecycleError(`Unknown profile: ${name}`, 400);
    }
    return { profileName: name, profile };
  }

  private resolveAgentDefinition(agentId: AgentId): AgentDefinition {
    const agent = getAgentDefinition(this.deps.config, agentId);
    if (!agent) {
      throw new LifecycleError(`Unknown agent: ${agentId}`, 400);
    }
    return agent;
  }

  private mapRuntimeState(
    state: ReturnType<ProjectRuntime["listMainChats"]>[number],
    now: () => Date,
  ): MainChatSnapshot {
    return {
      id: state.chatId,
      agentId: state.agentId,
      agentLabel: getAgentDefinition(this.deps.config, state.agentId)?.label ?? state.agentId,
      profile: state.profile,
      path: state.path,
      mux: state.session.exists,
      status: state.session.exists ? state.agent.lifecycle : "closed",
      elapsed: formatElapsedSince(state.createdAt, now),
      approvalPrompt: state.agent.approvalPrompt ? { ...state.agent.approvalPrompt } : null,
      paneCount: state.session.paneCount,
    };
  }
}

export function mainChatSnapshotToWorktreeSnapshot(
  chat: MainChatSnapshot,
  findAgentLabel?: (agentId: string | null) => string | null,
): import("../domain/model").WorktreeSnapshot {
  return {
    branch: chat.id,
    label: `${chat.agentLabel ?? chat.agentId} (project)`,
    path: chat.path,
    dir: chat.path,
    archived: false,
    profile: chat.profile,
    agentName: chat.agentId,
    agentLabel: findAgentLabel ? findAgentLabel(chat.agentId) : chat.agentLabel,
    mux: chat.mux,
    dirty: false,
    unpushed: false,
    paneCount: chat.paneCount,
    status: chat.status,
    elapsed: chat.elapsed,
    approvalPrompt: chat.approvalPrompt,
    services: [],
    prs: [],
    linearIssue: null,
    creation: null,
    source: "ui",
    oneshot: null,
  };
}

export function createMainChatMetaReader(projectGitDir: string): {
  readMeta: (agentId: string) => Promise<MainChatMeta | null>;
  writeMeta: (agentId: string, meta: MainChatMeta) => Promise<void>;
} {
  return {
    readMeta: (agentId) => readMainChatMeta(projectGitDir, agentId),
    writeMeta: (agentId, meta) => writeMainChatMeta(projectGitDir, meta),
  };
}

export function mainChatMetaToWorktreeMetaAdapter(
  meta: MainChatMeta,
  mainBranch: string,
): import("../domain/model").WorktreeMeta {
  return mainChatMetaAsWorktreeMeta(meta, mainBranch);
}
