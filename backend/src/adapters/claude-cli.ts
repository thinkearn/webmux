import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CUSTOM_AGENT_DEFAULTS } from "@webmux/api-contract";
import { log } from "../lib/log";

export type ClaudeCliConversationMessageKind = "text" | "thinking" | "toolUse" | "toolResult";

export interface ClaudeCliConversationMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string | null;
  kind?: ClaudeCliConversationMessageKind;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  cwd?: string;
}

export interface ClaudeCliSession {
  sessionId: string;
  cwd: string;
  path: string;
  gitBranch: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  messages: ClaudeCliConversationMessage[];
}

export interface ClaudeCliSessionSummary {
  sessionId: string;
  cwd: string;
  path: string;
  lastSeenAt: string;
}

export interface ClaudeCliRunCallbacks {
  onAssistantDelta?: (delta: string) => void;
  onComplete?: (sessionId: string) => void;
  onError?: (message: string) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface ClaudeCliRunHandle {
  completion: Promise<void>;
  interrupt: () => void;
  sessionId: Promise<string>;
}

export interface ClaudeCliOptions {
  command?: string;
  historyRoot?: string;
}

export interface ClaudeCliGateway {
  listSessions(cwd: string, options?: ClaudeCliOptions): Promise<ClaudeCliSessionSummary[]>;
  readSession(sessionId: string, cwd: string, options?: ClaudeCliOptions): Promise<ClaudeCliSession | null>;
  sendMessage(
    params: {
      cwd: string;
      prompt: string;
      resumeSessionId?: string | null;
      options?: ClaudeCliOptions;
    },
    callbacks: ClaudeCliRunCallbacks,
  ): ClaudeCliRunHandle;
}

interface ClaudeStoredRecord {
  content?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  id?: unknown;
  message?: unknown;
  parentId?: unknown;
  role?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  uuid?: unknown;
}

interface ClaudeStoredMessage {
  content?: unknown;
  role?: unknown;
  stop_reason?: unknown;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function readString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readTimestamp(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  return null;
}

function extractClaudeMessageText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.trim();
  }

  if (!Array.isArray(raw)) {
    return "";
  }

  return raw
    .map((entry) => {
      if (!isRecord(entry)) return "";
      if (entry.type !== "text" && entry.type !== "input_text" && entry.type !== "output_text") return "";
      return typeof entry.text === "string" ? entry.text : "";
    })
    .join("")
    .trim();
}

const TOOL_PAYLOAD_TRUNCATE_LIMIT = 2000;

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, limit = TOOL_PAYLOAD_TRUNCATE_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated, ${text.length - limit} more chars)`;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return truncate(content.trim());
  if (!Array.isArray(content)) return truncate(compactJson(content));
  const text = content
    .map((entry) => {
      if (!isRecord(entry)) return "";
      if (entry.type === "text" && typeof entry.text === "string") return entry.text;
      return compactJson(entry);
    })
    .join("")
    .trim();
  return truncate(text);
}

function isTopLevelClaudeUserPrompt(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { content: string; role: "user" };
  type: "user";
  uuid: string;
} {
  if (raw.type !== "user" || !isRecord(raw.message)) return false;
  return raw.message.role === "user"
    && typeof raw.message.content === "string"
    && typeof raw.uuid === "string"
    && raw.message.content.trim().length > 0;
}

function isClaudeUserToolResultRecord(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { content: unknown[]; role: "user" };
  type: "user";
  uuid: string;
} {
  if (raw.type !== "user" || !isRecord(raw.message)) return false;
  return raw.message.role === "user"
    && Array.isArray(raw.message.content)
    && typeof raw.uuid === "string";
}

function isClaudeAssistantRecord(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { role: "assistant" };
  type: "assistant";
  uuid: string;
} {
  if (raw.type !== "assistant" || !isRecord(raw.message)) return false;
  return raw.message.role === "assistant" && typeof raw.uuid === "string";
}

function isCodeBuddyMessageRecord(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  id: string;
  role: "user" | "assistant";
  type: "message";
} {
  return raw.type === "message"
    && (raw.role === "user" || raw.role === "assistant")
    && typeof raw.id === "string";
}

export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function expandHomePath(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = Bun.env.HOME;
    if (!home) {
      throw new Error("HOME is required to resolve Claude sessions");
    }
    return path === "~" ? home : join(home, path.slice(2));
  }
  return path;
}

function readClaudeProjectsRoot(options: ClaudeCliOptions = {}): string {
  return expandHomePath(options.historyRoot ?? CUSTOM_AGENT_DEFAULTS.claude.historyRoot);
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function findClaudeSessionPath(sessionId: string, cwd: string, options: ClaudeCliOptions = {}): Promise<string | null> {
  const projectsRoot = readClaudeProjectsRoot(options);
  const primaryPath = join(projectsRoot, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    await stat(primaryPath);
    return primaryPath;
  } catch {
    // Fall through to a broader scan.
  }

  const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function parseClaudeSessionRecords(text: string): ClaudeStoredRecord[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeStoredRecord];
      } catch {
        // The prefix filter already drops obvious non-JSON noise, so anything
        // reaching this catch is a corrupt JSON record — warn so a regression
        // (e.g. partial write, truncated session file) is visible.
        log.warn(`[agents] failed to parse Claude session line: ${line.slice(0, 120)}`);
        return [];
      }
    });
}

export function buildClaudeSessionFromText(
  input: {
    path: string;
    sessionId: string;
    text: string;
  },
): ClaudeCliSession {
  const records = parseClaudeSessionRecords(input.text);
  const messages: ClaudeCliConversationMessage[] = [];
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let createdAt: string | null = null;
  let lastSeenAt: string | null = null;
  let currentTurnId: string | null = null;
  let blockIndex = 0;

  const pushMessage = (message: ClaudeCliConversationMessage): void => {
    messages.push(message);
    blockIndex += 1;
  };

  for (const record of records) {
    cwd ??= readString(record.cwd);
    gitBranch ??= readString(record.gitBranch);
    const timestamp = readTimestamp(record.timestamp);
    if (!createdAt) {
      createdAt = timestamp;
    }
    lastSeenAt = timestamp ?? lastSeenAt;

    if (isCodeBuddyMessageRecord(record)) {
      const text = extractClaudeMessageText(record.content);
      if (text.length === 0) continue;
      if (record.role === "user") {
        currentTurnId = record.id;
        blockIndex = 0;
        pushMessage({
          id: record.id,
          turnId: record.id,
          role: "user",
          kind: "text",
          text,
          createdAt: timestamp,
        });
        continue;
      }
      if (!currentTurnId) currentTurnId = typeof record.parentId === "string" ? record.parentId : record.id;
      pushMessage({
        id: `${record.id}:${blockIndex}`,
        turnId: currentTurnId,
        role: "assistant",
        kind: "text",
        text,
        createdAt: timestamp,
      });
      continue;
    }

    if (isTopLevelClaudeUserPrompt(record)) {
      currentTurnId = record.uuid;
      blockIndex = 0;
      pushMessage({
        id: record.uuid,
        turnId: record.uuid,
        role: "user",
        kind: "text",
        text: record.message.content.trim(),
        createdAt: timestamp,
      });
      continue;
    }

    if (!currentTurnId) continue;

    if (isClaudeUserToolResultRecord(record)) {
      for (const entry of record.message.content) {
        if (!isRecord(entry) || entry.type !== "tool_result") continue;
        const text = extractToolResultText(entry.content);
        if (text.length === 0) continue;
        const toolCallId = typeof entry.tool_use_id === "string" ? entry.tool_use_id : undefined;
        pushMessage({
          id: `${record.uuid}:${blockIndex}`,
          turnId: currentTurnId,
          role: "user",
          kind: "toolResult",
          text,
          toolCallId,
          createdAt: timestamp,
        });
      }
      continue;
    }

    if (!isClaudeAssistantRecord(record)) continue;
    if (!Array.isArray(record.message.content)) continue;

    for (const block of record.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const text = block.thinking.trim();
        if (text.length === 0) continue;
        pushMessage({
          id: `${record.uuid}:${blockIndex}`,
          turnId: currentTurnId,
          role: "assistant",
          kind: "thinking",
          text,
          createdAt: timestamp,
        });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text.length === 0) continue;
        pushMessage({
          id: `${record.uuid}:${blockIndex}`,
          turnId: currentTurnId,
          role: "assistant",
          kind: "text",
          text,
          createdAt: timestamp,
        });
        continue;
      }
      if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" ? block.name : "tool";
        const toolCallId = typeof block.id === "string" ? block.id : undefined;
        const input = isRecord(block.input) ? block.input : {};
        const text = truncate(compactJson(input));
        const command = typeof input.command === "string" ? input.command : undefined;
        const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
        pushMessage({
          id: `${record.uuid}:${blockIndex}`,
          turnId: currentTurnId,
          role: "assistant",
          kind: "toolUse",
          toolName,
          text,
          toolCallId,
          command,
          cwd,
          createdAt: timestamp,
        });
        continue;
      }
    }
  }

  return {
    sessionId: input.sessionId,
    cwd: cwd ?? "",
    path: input.path,
    gitBranch,
    createdAt,
    lastSeenAt,
    messages,
  };
}

export class ClaudeCliClient implements ClaudeCliGateway {
  async listSessions(cwd: string, options: ClaudeCliOptions = {}): Promise<ClaudeCliSessionSummary[]> {
    const projectsRoot = readClaudeProjectsRoot(options);
    const primaryDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const primaryFiles = await listJsonlFiles(primaryDir);
    if (primaryFiles.length > 0) {
      return await this.summarizeSessionFiles(primaryFiles, cwd);
    }

    const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    const matchedFiles: string[] = [];
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const files = await listJsonlFiles(join(projectsRoot, entry.name));
      for (const filePath of files) {
        const session = await this.readSessionFile(filePath);
        if (session?.cwd === cwd) {
          matchedFiles.push(filePath);
        }
      }
    }

    return await this.summarizeSessionFiles(matchedFiles, cwd);
  }

  async readSession(sessionId: string, cwd: string, options: ClaudeCliOptions = {}): Promise<ClaudeCliSession | null> {
    const filePath = await findClaudeSessionPath(sessionId, cwd, options);
    if (!filePath) return null;
    return await this.readSessionFile(filePath);
  }

  sendMessage(
    params: {
      cwd: string;
      prompt: string;
      resumeSessionId?: string | null;
    },
    callbacks: ClaudeCliRunCallbacks,
  ): ClaudeCliRunHandle {
    const args = [params.options?.command ?? CUSTOM_AGENT_DEFAULTS.claude.command, "-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
    if (params.resumeSessionId) {
      args.push("-r", params.resumeSessionId);
    }

    const proc = Bun.spawn(args, {
      cwd: params.cwd,
      env: Bun.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let resolvedSessionId: string | null = null;
    let sessionIdResolve: ((value: string) => void) | null = null;
    let sessionIdReject: ((reason?: unknown) => void) | null = null;
    let interrupted = false;
    const sessionId = new Promise<string>((resolve, reject) => {
      sessionIdResolve = resolve;
      sessionIdReject = reject;
    });

    const resolveSessionId = (value: string): void => {
      if (resolvedSessionId === value) return;
      resolvedSessionId = value;
      sessionIdResolve?.(value);
      sessionIdResolve = null;
      sessionIdReject = null;
      callbacks.onSessionId?.(value);
    };

    const rejectSessionId = (error: Error): void => {
      sessionIdReject?.(error);
      sessionIdResolve = null;
      sessionIdReject = null;
    };

    const completion = (async () => {
      const stdoutReader = proc.stdout.getReader();
      const stderrReader = proc.stderr.getReader();
      let stdoutBuffer = "";
      let stderrBuffer = "";

      const stdoutLoop = (async () => {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value);

          while (true) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) break;
            const line = stdoutBuffer.slice(0, newlineIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (line.length === 0) continue;
            this.handleStreamLine(line, callbacks, resolveSessionId);
          }
        }
      })();

      const stderrLoop = (async () => {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrBuffer += decoder.decode(value);
        }
      })();

      await Promise.all([stdoutLoop, stderrLoop]);
      const exitCode = await proc.exited;

      if (exitCode !== 0 && !interrupted) {
        const message = stderrBuffer.trim() || `claude exited with code ${exitCode}`;
        rejectSessionId(new Error(message));
        callbacks.onError?.(message);
      }
    })();

    void proc.stdin.write(encoder.encode(params.prompt.endsWith("\n") ? params.prompt : `${params.prompt}\n`));
    proc.stdin.end();

    return {
      completion,
      interrupt: () => {
        interrupted = true;
        proc.kill();
      },
      sessionId,
    };
  }

  private async summarizeSessionFiles(filePaths: string[], cwd: string): Promise<ClaudeCliSessionSummary[]> {
    const items = await Promise.all(filePaths.map(async (filePath) => {
      const info = await stat(filePath).catch(() => null);
      if (!info) return null;
      return {
        sessionId: basename(filePath, ".jsonl"),
        cwd,
        path: filePath,
        lastSeenAt: info.mtime.toISOString(),
      };
    }));

    return items
      .filter((item): item is ClaudeCliSessionSummary => item !== null)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  private async readSessionFile(filePath: string): Promise<ClaudeCliSession | null> {
    try {
      const text = await Bun.file(filePath).text();
      return buildClaudeSessionFromText({
        path: filePath,
        sessionId: basename(filePath, ".jsonl"),
        text,
      });
    } catch {
      return null;
    }
  }

  private handleStreamLine(
    line: string,
    callbacks: ClaudeCliRunCallbacks,
    resolveSessionId: (value: string) => void,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn(`[agents] failed to parse Claude stream line: ${line.slice(0, 120)}`);
      return;
    }

    if (!isRecord(parsed)) return;

    const sessionId = readString(parsed.session_id);
    if (sessionId) {
      resolveSessionId(sessionId);
    }

    if (parsed.type === "stream_event" && isRecord(parsed.event)) {
      const event = parsed.event;
      if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
        const delta = readString(event.delta.text);
        if (delta) {
          callbacks.onAssistantDelta?.(delta);
        }
      }
      return;
    }

    if (parsed.type === "result") {
      const resultSessionId = readString(parsed.session_id);
      if (resultSessionId) {
        resolveSessionId(resultSessionId);
        callbacks.onComplete?.(resultSessionId);
      }

      if (parsed.is_error === true) {
        callbacks.onError?.(readString(parsed.result) ?? "Claude returned an error");
      }
      return;
    }

    if (parsed.type === "error") {
      callbacks.onError?.(readString(parsed.message) ?? "Claude returned an error");
    }
  }
}
