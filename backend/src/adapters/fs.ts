import { readdirSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchivedWorktreeEntry,
  ClaudeWorktreeConversationMeta,
  CiCheck,
  CodexWorktreeConversationMeta,
  ControlEnvMap,
  PrComment,
  PrEntry,
  WorktreeConversationMeta,
  WorktreeArchiveState,
  WorktreeMeta,
  WorktreeStoragePaths,
} from "../domain/model";
import type { MainChatMeta } from "../domain/main-chat";
import { MAIN_CHAT_META_SCHEMA_VERSION } from "../domain/main-chat";
import { WORKTREE_ARCHIVE_STATE_VERSION, WORKTREE_META_SCHEMA_VERSION } from "../domain/model";

const SAFE_ENV_VALUE_RE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const DOTENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/;

function stringifyAllocatedPorts(ports: Record<string, number>): Record<string, string> {
  const entries = Object.entries(ports).map(([key, value]) => [key, String(value)]);
  return Object.fromEntries(entries);
}

function quoteEnvValue(value: string): string {
  if (value.length > 0 && SAFE_ENV_VALUE_RE.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const match = DOTENV_LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      value = value.trimEnd();
    }
    env[key] = value;
  }
  return env;
}

export async function loadDotenvLocal(worktreePath: string): Promise<Record<string, string>> {
  try {
    const content = await Bun.file(join(worktreePath, ".env.local")).text();
    return parseDotenv(content);
  } catch {
    return {};
  }
}

export function getWorktreeStoragePaths(gitDir: string): WorktreeStoragePaths {
  const webmuxDir = join(gitDir, "webmux");
  return {
    gitDir,
    webmuxDir,
    metaPath: join(webmuxDir, "meta.json"),
    runtimeEnvPath: join(webmuxDir, "runtime.env"),
    controlEnvPath: join(webmuxDir, "control.env"),
    prsPath: join(webmuxDir, "prs.json"),
  };
}

export function getProjectArchiveStatePath(gitDir: string): string {
  return join(gitDir, "webmux", "archive.json");
}

export async function ensureWorktreeStorageDirs(gitDir: string): Promise<WorktreeStoragePaths> {
  const paths = getWorktreeStoragePaths(gitDir);
  await mkdir(paths.webmuxDir, { recursive: true });
  return paths;
}

export async function readWorktreeMeta(gitDir: string): Promise<WorktreeMeta | null> {
  const { metaPath } = getWorktreeStoragePaths(gitDir);
  try {
    const raw = await Bun.file(metaPath).json() as WorktreeMeta;
    return normalizeWorktreeMeta(raw);
  } catch {
    return null;
  }
}

export async function writeWorktreeMeta(gitDir: string, meta: WorktreeMeta): Promise<void> {
  const { metaPath } = await ensureWorktreeStorageDirs(gitDir);
  await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

function isArchivedWorktreeEntry(raw: unknown): raw is ArchivedWorktreeEntry {
  return isRecord(raw)
    && typeof raw.path === "string"
    && typeof raw.archivedAt === "string";
}

function emptyWorktreeArchiveState(): WorktreeArchiveState {
  return {
    schemaVersion: WORKTREE_ARCHIVE_STATE_VERSION,
    entries: [],
  };
}

function isWorktreeArchiveState(raw: unknown): raw is WorktreeArchiveState {
  return isRecord(raw)
    && typeof raw.schemaVersion === "number"
    && Array.isArray(raw.entries)
    && raw.entries.every((entry) => isArchivedWorktreeEntry(entry));
}

export async function readWorktreeArchiveState(gitDir: string): Promise<WorktreeArchiveState> {
  const archivePath = getProjectArchiveStatePath(gitDir);
  try {
    const raw: unknown = await Bun.file(archivePath).json();
    return isWorktreeArchiveState(raw)
      ? {
          schemaVersion: raw.schemaVersion,
          entries: raw.entries.map((entry) => ({ ...entry })),
        }
      : emptyWorktreeArchiveState();
  } catch {
    return emptyWorktreeArchiveState();
  }
}

export async function writeWorktreeArchiveState(gitDir: string, state: WorktreeArchiveState): Promise<void> {
  const archivePath = getProjectArchiveStatePath(gitDir);
  await ensureWorktreeStorageDirs(gitDir);
  await Bun.write(archivePath, JSON.stringify(state, null, 2) + "\n");
}

export function buildRuntimeEnvMap(
  meta: WorktreeMeta,
  extraEnv: Record<string, string> = {},
  dotenvValues: Record<string, string> = {},
): Record<string, string> {
  return {
    ...dotenvValues,
    ...meta.startupEnvValues,
    ...stringifyAllocatedPorts(meta.allocatedPorts),
    ...extraEnv,
    WEBMUX_WORKTREE_ID: meta.worktreeId,
    WEBMUX_BRANCH: meta.branch,
    WEBMUX_PROFILE: meta.profile,
    WEBMUX_AGENT: meta.agent,
    WEBMUX_RUNTIME: meta.runtime,
  };
}

export function buildControlEnvMap(input: {
  controlUrl: string;
  controlToken: string;
  worktreeId: string;
  branch: string;
}): ControlEnvMap {
  return {
    WEBMUX_CONTROL_URL: input.controlUrl,
    WEBMUX_CONTROL_TOKEN: input.controlToken,
    WEBMUX_WORKTREE_ID: input.worktreeId,
    WEBMUX_BRANCH: input.branch,
  };
}

export function renderEnvFile(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  return lines.join("\n") + "\n";
}

export async function writeRuntimeEnv(gitDir: string, env: Record<string, string>): Promise<void> {
  const { runtimeEnvPath } = await ensureWorktreeStorageDirs(gitDir);
  await Bun.write(runtimeEnvPath, renderEnvFile(env));
}

export async function writeControlEnv(gitDir: string, env: ControlEnvMap): Promise<void> {
  const { controlEnvPath } = await ensureWorktreeStorageDirs(gitDir);
  await Bun.write(controlEnvPath, renderEnvFile(env));
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function normalizeConversationMeta(raw: WorktreeConversationMeta | null | undefined): WorktreeConversationMeta | null | undefined {
  if (!raw) return raw;

  if (raw.provider === "codexAppServer") {
    const conversationId = raw.conversationId || raw.threadId;
    const threadId = raw.threadId || raw.conversationId;
    if (!conversationId || !threadId) return undefined;
    const normalized: CodexWorktreeConversationMeta = {
      provider: "codexAppServer",
      conversationId,
      threadId,
      cwd: raw.cwd,
      lastSeenAt: raw.lastSeenAt,
    };
    return normalized;
  }

  const conversationId = raw.conversationId || raw.sessionId;
  const sessionId = raw.sessionId || raw.conversationId;
  if (!conversationId || !sessionId) return undefined;
  const normalized: ClaudeWorktreeConversationMeta = {
    provider: "claudeCode",
    conversationId,
    sessionId,
    cwd: raw.cwd,
    lastSeenAt: raw.lastSeenAt,
  };
  return normalized;
}

function normalizeOptionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function normalizeWorktreeMeta(meta: WorktreeMeta): WorktreeMeta {
  const conversation = normalizeConversationMeta(meta.conversation);
  const normalizedLabel = normalizeOptionalString(meta.label);
  if (conversation === meta.conversation && normalizedLabel === meta.label) {
    return meta;
  }

  const rest: WorktreeMeta = { ...meta };
  delete rest.label;
  delete rest.conversation;
  return {
    ...rest,
    ...(normalizedLabel ? { label: normalizedLabel } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
  };
}

function isPrComment(raw: unknown): raw is PrComment {
  if (!isRecord(raw)) return false;
  return (raw.type === "comment" || raw.type === "inline")
    && typeof raw.author === "string"
    && typeof raw.body === "string"
    && typeof raw.createdAt === "string"
    && (raw.path === undefined || typeof raw.path === "string")
    && (raw.line === undefined || raw.line === null || typeof raw.line === "number")
    && (raw.diffHunk === undefined || typeof raw.diffHunk === "string")
    && (raw.isReply === undefined || typeof raw.isReply === "boolean");
}

function isCiCheck(raw: unknown): raw is CiCheck {
  if (!isRecord(raw)) return false;
  return typeof raw.name === "string"
    && (raw.status === "pending"
      || raw.status === "success"
      || raw.status === "failed"
      || raw.status === "skipped")
    && (raw.url === null || typeof raw.url === "string")
    && (raw.runId === null || typeof raw.runId === "number");
}

function isPrEntry(raw: unknown): raw is PrEntry {
  if (!isRecord(raw)) return false;
  return typeof raw.repo === "string"
    && typeof raw.number === "number"
    && (raw.state === "open" || raw.state === "closed" || raw.state === "merged")
    && typeof raw.url === "string"
    && typeof raw.updatedAt === "string"
    && (raw.ciStatus === "none"
      || raw.ciStatus === "pending"
      || raw.ciStatus === "success"
      || raw.ciStatus === "failed")
    && Array.isArray(raw.ciChecks)
    && raw.ciChecks.every((check) => isCiCheck(check))
    && Array.isArray(raw.comments)
    && raw.comments.every((comment) => isPrComment(comment));
}

export async function readWorktreePrs(gitDir: string): Promise<PrEntry[]> {
  const { prsPath } = getWorktreeStoragePaths(gitDir);
  try {
    const raw: unknown = await Bun.file(prsPath).json();
    return Array.isArray(raw) && raw.every((entry) => isPrEntry(entry))
      ? raw
      : [];
  } catch {
    return [];
  }
}

export async function writeWorktreePrs(gitDir: string, prs: PrEntry[]): Promise<void> {
  const { prsPath } = await ensureWorktreeStorageDirs(gitDir);
  await Bun.write(prsPath, JSON.stringify(prs, null, 2) + "\n");
}

export interface MainChatStoragePaths {
  storageDir: string;
  metaPath: string;
  runtimeEnvPath: string;
  controlEnvPath: string;
}

export function getMainChatStoragePaths(projectGitDir: string, agentId: string): MainChatStoragePaths {
  const storageDir = join(projectGitDir, "webmux", "main-chats", agentId);
  return {
    storageDir,
    metaPath: join(storageDir, "meta.json"),
    runtimeEnvPath: join(storageDir, "runtime.env"),
    controlEnvPath: join(storageDir, "control.env"),
  };
}

export async function ensureMainChatStorageDirs(projectGitDir: string, agentId: string): Promise<MainChatStoragePaths> {
  const paths = getMainChatStoragePaths(projectGitDir, agentId);
  await mkdir(paths.storageDir, { recursive: true });
  return paths;
}

function isMainChatMeta(raw: unknown): raw is MainChatMeta {
  return isRecord(raw)
    && typeof raw.schemaVersion === "number"
    && typeof raw.chatId === "string"
    && typeof raw.worktreeId === "string"
    && typeof raw.agent === "string"
    && typeof raw.profile === "string"
    && typeof raw.runtime === "string"
    && typeof raw.createdAt === "string"
    && isRecord(raw.startupEnvValues)
    && isRecord(raw.allocatedPorts);
}

function normalizeMainChatMeta(meta: MainChatMeta): MainChatMeta {
  const conversation = normalizeConversationMeta(meta.conversation);
  if (conversation === meta.conversation) return meta;
  const rest: MainChatMeta = { ...meta };
  delete rest.conversation;
  return {
    ...rest,
    ...(conversation !== undefined ? { conversation } : {}),
  };
}

export async function readMainChatMeta(projectGitDir: string, agentId: string): Promise<MainChatMeta | null> {
  const { metaPath } = getMainChatStoragePaths(projectGitDir, agentId);
  try {
    const raw: unknown = await Bun.file(metaPath).json();
    if (!isMainChatMeta(raw)) return null;
    return normalizeMainChatMeta(raw);
  } catch {
    return null;
  }
}

export async function writeMainChatMeta(projectGitDir: string, meta: MainChatMeta): Promise<void> {
  const { metaPath } = await ensureMainChatStorageDirs(projectGitDir, meta.agent);
  await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

export async function removeMainChatStorage(projectGitDir: string, agentId: string): Promise<void> {
  const { storageDir } = getMainChatStoragePaths(projectGitDir, agentId);
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function listMainChatAgentIds(projectGitDir: string): Promise<string[]> {
  const root = join(projectGitDir, "webmux", "main-chats");
  try {
    return readdirSync(root)
      .filter((entry) => {
        try {
          return statSync(join(root, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function writeMainChatRuntimeEnv(projectGitDir: string, agentId: string, env: Record<string, string>): Promise<void> {
  const { runtimeEnvPath } = await ensureMainChatStorageDirs(projectGitDir, agentId);
  await Bun.write(runtimeEnvPath, renderEnvFile(env));
}

export async function writeMainChatControlEnv(projectGitDir: string, agentId: string, env: ControlEnvMap): Promise<void> {
  const { controlEnvPath } = await ensureMainChatStorageDirs(projectGitDir, agentId);
  await Bun.write(controlEnvPath, renderEnvFile(env));
}

export function mainChatMetaAsWorktreeMeta(meta: MainChatMeta, branch: string): WorktreeMeta {
  return {
    schemaVersion: WORKTREE_META_SCHEMA_VERSION,
    worktreeId: meta.worktreeId,
    branch,
    createdAt: meta.createdAt,
    profile: meta.profile,
    agent: meta.agent,
    runtime: meta.runtime,
    startupEnvValues: { ...meta.startupEnvValues },
    allocatedPorts: { ...meta.allocatedPorts },
    ...(meta.conversation !== undefined ? { conversation: meta.conversation } : {}),
  };
}

export function buildMainChatMeta(input: {
  chatId: string;
  worktreeId: string;
  agent: MainChatMeta["agent"];
  profile: string;
  runtime: MainChatMeta["runtime"];
  startupEnvValues?: Record<string, string>;
  allocatedPorts?: Record<string, number>;
  now?: () => Date;
}): MainChatMeta {
  return {
    schemaVersion: MAIN_CHAT_META_SCHEMA_VERSION,
    chatId: input.chatId,
    worktreeId: input.worktreeId,
    agent: input.agent,
    profile: input.profile,
    runtime: input.runtime,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    startupEnvValues: { ...(input.startupEnvValues ?? {}) },
    allocatedPorts: { ...(input.allocatedPorts ?? {}) },
  };
}
