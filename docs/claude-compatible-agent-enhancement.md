# Claude-Compatible Custom Agent 增强方案

## 1. 概述

本方案旨在增强 WebMux 对 Claude-compatible custom agents（如 CodeBuddy）的支持，实现：
- 模型上下文用量实时获取与展示
- 动态 slash command 发现（包括 skills）
- 移动端和 TMUX 端的消息同步

## 2. 模型上下文用量获取

### 2.1 设计原理

从 agent 的 `stream-json` 输出中解析 `usage` 字段，而不是依赖 `/context` 命令。

**数据来源**：
- Claude/CodeBuddy CLI 使用 `--output-format stream-json` 时，每个 `result` 事件包含 `usage` 字段
- Usage 字段包含：`input_tokens`, `output_tokens`, `total_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`

**优势**：
- 实时性好：每次 turn 完成立即获得用量
- 准确性高：直接从 agent 输出解析，避免中间状态错误
- 通用性强：所有支持 `--output-format stream-json` 的 agent 都适用

### 2.2 实现方案

#### 后端实现

**文件**：`backend/src/services/claude-stream-service.ts`（新建）

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model_context_window?: number;
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  usage?: TokenUsage;
  // ... other fields
}

export function parseStreamJsonUsage(event: StreamJsonEvent): TokenUsage | null {
  if (event.type !== 'result' || event.subtype !== 'success') {
    return null;
  }

  if (!event.usage) {
    return null;
  }

  return {
    input_tokens: event.usage.input_tokens || 0,
    output_tokens: event.usage.output_tokens || 0,
    total_tokens: event.usage.total_tokens,
    cache_creation_input_tokens: event.usage.cache_creation_input_tokens,
    cache_read_input_tokens: event.usage.cache_read_input_tokens,
  };
}

export function formatContextDisplay(usage: TokenUsage, contextWindow?: number): string {
  const used = usage.input_tokens + usage.output_tokens;
  if (!contextWindow) {
    return `Tokens used: ${used}`;
  }

  const pct = Math.round((used / contextWindow) * 100);
  return `Tokens used: ${used} / Context window: ${contextWindow} (${pct}%)`;
}
```

**文件**：`backend/src/services/agent-chat-service.ts`（修改）

在 `handleStreamJsonMessage` 中：
```typescript
function handleStreamJsonMessage(event: StreamJsonEvent, ws: WebSocket) {
  // ... existing code ...

  // 解析并推送 token usage
  const usage = parseStreamJsonUsage(event);
  if (usage) {
    const message = {
      type: 'token_usage_info',
      usage: usage,
      display: formatContextDisplay(usage, agentConfig.contextWindow),
      timestamp: Date.now()
    };
    ws.send(JSON.stringify(message));
  }
}
```

#### 前端实现

**文件**：`frontend/src/lib/WorktreeConversationPanel.svelte`（修改）

```typescript
// 从 conversation timeline 获取最新的 token usage
let tokenUsageInfo = $derived.by(() => {
  if (!conversationTimeline || conversationTimeline.length === 0) return null;

  // 从后向前查找最后一条 token_usage_info
  for (let i = conversationTimeline.length - 1; i >= 0; i--) {
    const msg = conversationTimeline[i];
    if (msg.type === 'token_usage_info' && msg.usage) {
      return msg.usage;
    }
  }
  return null;
});

// 展示 context 用量
let contextDisplay = $derived.by(() => {
  if (!tokenUsageInfo) return null;

  const used = (tokenUsageInfo.input_tokens || 0) + (tokenUsageInfo.output_tokens || 0);
  const window = tokenUsageInfo.model_context_window || agentConfig?.contextWindow || 200000;
  const pct = Math.round((used / window) * 100);

  return {
    used,
    window,
    percentage: pct,
    display: `Context: ${formatTokenCount(used)} / ${formatTokenCount(window)} (${pct}%)`
  };
});
```

### 2.3 处理 CodeBuddy 格式差异

**问题**：CodeBuddy 的 JSONL 格式与 Claude 不完全一致

**解决方案**：在 `backend/src/adapters/claude-cli.ts` 中增加格式检测

```typescript
function detectAgentFormat(jsonlRecord: Record<string, unknown>): 'claude' | 'codebuddy' {
  // Claude format: type: "result", usage: { input_tokens, output_tokens }
  // CodeBuddy format: type: "result", token_usage: { input_tokens, output_tokens }
  if (jsonlRecord.token_usage) return 'codebuddy';
  if (jsonlRecord.usage) return 'claude';

  // 更详细的检测逻辑
  if (jsonlRecord.type === 'message') return 'codebuddy';
  return 'claude';
}

function normalizeUsage(usage: Record<string, unknown>, format: 'claude' | 'codebuddy'): TokenUsage {
  if (format === 'codebuddy') {
    const cbUsage = usage.token_usage || usage;
    return {
      input_tokens: cbUsage.input_tokens || cbUsage.inputTokens || 0,
      output_tokens: cbUsage.output_tokens || cbUsage.outputTokens || 0,
      cache_creation_input_tokens: cbUsage.cache_creation_input_tokens || cbUsage.cacheCreationInputTokens,
      cache_read_input_tokens: cbUsage.cache_read_input_tokens || cbUsage.cacheReadInputTokens,
    };
  }

  // Claude format
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  };
}
```

## 3. 动态 Slash Command 发现

### 3.1 设计原理

参考 [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) 的实现，从 CLI runtime发现获取 slash commands，而不是扫描文件系统。

**核心思路**：
1. 启动一次轻量级 CLI 会话（`--max-turns 1`）
2. 从 `system init` 事件的 `slash_commands` 字段获取当前会话实际加载的 commands
3. 包括内置命令和动态加载的 skills

### 3.2 实现方案

#### 后端 API

**文件**：`backend/src/server.ts`（修改）

```typescript
// 新增 API 端点
app.get('/api/agents/:agentId/slash-commands', async (c) => {
  const agentId = c.req.param('agentId');
  const agent = agentRegistry.getAgent(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  try {
    const commands = await discoverSlashCommands(agent);
    return c.json({ commands });
  } catch (error) {
    return c.json({ error: 'Failed to discover slash commands' }, 500);
  }
});
```

**文件**：`backend/src/services/slash-command-discovery.ts`（新建）

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import { spawn } from 'bun';

const execAsync = promisify(exec);

export interface SlashCommand {
  name: string;
  description: string;
  type: 'builtin' | 'skill' | 'custom';
  source?: string; // skill 来源路径
}

export async function discoverSlashCommands(agent: AgentConfig): Promise<SlashCommand[]> {
  // 对 Claude-compatible agents 使用 CLI discovery
  if (agent.type === 'claude-compatible') {
    return discoverFromCli(agent);
  }

  // 对其他 agents 返回静态列表
  return getStaticCommands(agent);
}

async function discoverFromCli(agent: AgentConfig): Promise<SlashCommand[]> {
  const command = agent.claude?.command || 'claude';

  // 启动轻量会话获取 system init 信息
  const proc = spawn({
    cmd: [
      command,
      '-p',                    // print mode
      '--verbose',              // 输出详细信息
      '--output-format', 'stream-json',
      '--max-turns', '1',      // 只运行 1 个 turn
      '--',                     // 分隔符
      '/',                      // 触发 slash command 列表
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const commands: SlashCommand[] = [];
  const seenTypes = new Set<string>();

  try {
    let buffer = '';
    const reader = proc.stdout.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          // 从 system init 事件中提取 slash_commands
          if (event.type === 'system' && event.subtype === 'init') {
            const slashCommands = event.slash_commands || [];

            for (const cmd of slashCommands) {
              commands.push({
                name: cmd.name,
                description: cmd.description || '',
                type: cmd.type || 'builtin',
                source: cmd.source,
              });
            }

            // 找到后立即终止进程
            proc.kill();
            break;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  } catch (error) {
    console.error('Error discovering slash commands:', error);
  } finally {
    proc.kill();
  }

  return commands;
}

function getStaticCommands(agent: AgentConfig): SlashCommand[] {
  // 返回静态命令列表（用于非 Claude-compatible agents）
  return [
    { name: '/help', description: 'Show help', type: 'builtin' },
    { name: '/clear', description: 'Clear conversation', type: 'builtin' },
    // ... 其他静态命令
  ];
}
```

#### 前端集成

**文件**：`frontend/src/lib/api.ts`（修改）

```typescript
export async function fetchAgentSlashCommands(agentId: string): Promise<SlashCommand[]> {
  const response = await fetch(`${API_BASE}/agents/${agentId}/slash-commands`);
  const data = await response.json();
  return data.commands || [];
}
```

**文件**：`frontend/src/lib/WorktreeConversationPanel.svelte`（修改）

```typescript
// 当用户输入 "/" 时触发 slash command 自动补全
let showSlashCommandList = $state(false);
let slashCommandFilter = $state('');
let availableSlashCommands = $state<SlashCommand[]>([]);

// 加载 slash commands
async function loadSlashCommands() {
  if (!worktree.agentName) return;

  try {
    availableSlashCommands = await fetchAgentSlashCommands(worktree.agentName);
  } catch (error) {
    console.error('Failed to load slash commands:', error);
  }
}

// 过滤 slash commands
let filteredSlashCommands = $derived.by(() => {
  if (!slashCommandFilter) return availableSlashCommands;

  const filter = slashCommandFilter.toLowerCase();
  return availableSlashCommands.filter(cmd =>
    cmd.name.toLowerCase().includes(filter) ||
    cmd.description.toLowerCase().includes(filter)
  );
});

// 监听用户输入，检测 "/" 触发
function handleInputChange(value: string) {
  if (value === '/') {
    slashCommandFilter = '';
    showSlashCommandList = true;
    loadSlashCommands();
  } else if (value.startsWith('/')) {
    slashCommandFilter = value.substring(1);
    showSlashCommandList = true;
  } else {
    showSlashCommandList = false;
  }
}
```

**UI 组件**：显示 slash command 列表

```svelte
{#if showSlashCommandList && filteredSlashCommands.length > 0}
  <div class="slash-command-dropdown">
    {#each filteredSlashCommands as cmd}
      <button
        class="slash-command-item"
        onclick={() => selectSlashCommand(cmd)}
      >
        <span class="cmd-name">{cmd.name}</span>
        <span class="cmd-desc">{cmd.description}</span>
        {#if cmd.type === 'skill'}
          <span class="cmd-badge">skill</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
```

### 3.3 缓存策略

为避免每次都启动 CLI 发现命令，增加缓存机制：

```typescript
// 缓存 slash commands（5 分钟有效期）
const slashCommandCache = new Map<string, { commands: SlashCommand[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function discoverSlashCommands(agent: AgentConfig): Promise<SlashCommand[]> {
  const cacheKey = `${agent.id}:${agent.version || 'default'}`;
  const cached = slashCommandCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.commands;
  }

  const commands = await discoverFromCli(agent);
  slashCommandCache.set(cacheKey, { commands, timestamp: Date.now() });

  return commands;
}
```

## 4. 移动端和 TMUX 端消息同步

### 4.1 设计原理

**目标**：
- PC 端展示原始 TUI 界面
- 移动端自动展示对话 UI 界面
- 两边自动同步，无需手动刷新

**挑战**：
- TUI 界面运行在 TMUX 中，移动端需要看到相同的对话内容
- 移动端发送消息后，TUI 需要实时更新
- 两边的状态需要保持一致

### 4.2 实现方案

#### 4.2.1 架构设计

```
┌─────────────┐         WebSocket         ┌─────────────┐
│   TMUX      │ ◄──────────────────────►  │   Backend   │
│  (TUI)      │     实时同步消息           │   Server     │
└─────────────┘                           └─────────────┘
                                                   ▲
                                                   │ WebSocket
                                                   ▼
                                            ┌─────────────┐
                                            │   Mobile    │
                                            │  (Web UI)   │
                                            └─────────────┘
```

#### 4.2.2 TMUX 端改造

**文件**：`backend/src/services/tmux-sync-service.ts`（新建）

```typescript
import { spawn } from 'bun';
import type { WebSocket } from 'bun';

export interface TmuxSyncSession {
  sessionId: string;
  worktreeId: string;
  tmuxPaneId: string;
  clients: Set<WebSocket>;
}

class TmuxSyncService {
  private sessions = new Map<string, TmuxSyncSession>();
  private captureProcesses = new Map<string, Subprocess>();

  /**
   * 启动 TMUX 输出捕获
   */
  async startCapture(sessionId: string, tmuxPaneId: string) {
    if (this.captureProcesses.has(sessionId)) {
      return; // 已经在捕获
    }

    // 使用 `tmux capture-pane` 定期捕获输出
    const proc = spawn({
      cmd: ['tmux', 'pipe-pane', '-t', tmuxPaneId, '-o', '#{pane_output}'],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.captureProcesses.set(sessionId, proc);

    // 定期读取并推送输出
    this.startPeriodicCapture(sessionId, tmuxPaneId);
  }

  /**
   * 定期捕获 TMUX pane 内容
   */
  private async startPeriodicCapture(sessionId: string, tmuxPaneId: string) {
    const interval = setInterval(async () => {
      try {
        // 捕获当前 pane 的内容
        const capture = await Bun.spawn([
          'tmux', 'capture-pane',
          '-t', tmuxPaneId,
          '-p',           // 输出到 stdout
          '-J',           // 连接换行
          '-S', '-100',   // 最近 100 行
        ]).exited;

        const output = await new Response(capture).text();

        // 解析输出，提取对话内容
        const messages = this.parseTmuxOutput(output);

        // 推送给所有连接的移动端客户端
        this.broadcastToClients(sessionId, {
          type: 'tmux_output',
          messages,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error('Error capturing TMUX output:', error);
      }
    }, 500); // 每 500ms 捕获一次

    // 保存 interval 以便停止
    this.sessions.get(sessionId)!.captureInterval = interval;
  }

  /**
   * 解析 TMUX 输出，提取对话消息
   */
  private parseTmuxOutput(output: string): ParsedMessage[] {
    const messages: ParsedMessage[] = [];
    const lines = output.split('\n');

    let currentMessage: Partial<ParsedMessage> | null = null;

    for (const line of lines) {
      // 检测用户消息（通常以 ">" 或 "Human:" 开头）
      if (line.match(/^>\s*|Human:\s*/)) {
        if (currentMessage) {
          messages.push(currentMessage as ParsedMessage);
        }
        currentMessage = {
          role: 'user',
          content: line.replace(/^>\s*|Human:\s*/, ''),
          timestamp: Date.now(),
        };
      }
      // 检测助手消息（通常以 "Claude:" 或特定格式开头）
      else if (line.match(/^Claude:\s*|Assistant:\s*/)) {
        if (currentMessage) {
          messages.push(currentMessage as ParsedMessage);
        }
        currentMessage = {
          role: 'assistant',
          content: line.replace(/^Claude:\s*|Assistant:\s*/, ''),
          timestamp: Date.now(),
        };
      }
      // 继续追加内容
      else if (currentMessage) {
        currentMessage.content += '\n' + line;
      }
    }

    if (currentMessage) {
      messages.push(currentMessage as ParsedMessage);
    }

    return messages;
  }

  /**
   * 广播消息给所有连接的客户端
   */
  private broadcastToClients(sessionId: string, message: any) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data = JSON.stringify(message);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * 注册移动端客户端
   */
  registerClient(sessionId: string, client: WebSocket) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // 创建新 session
      this.sessions.set(sessionId, {
        sessionId,
        worktreeId: '',
        tmuxPaneId: '',
        clients: new Set([client]),
      });
    } else {
      session.clients.add(client);
    }
  }

  /**
   * 取消注册客户端
   */
  unregisterClient(sessionId: string, client: WebSocket) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.clients.delete(client);

    // 如果没有客户端了，停止捕获
    if (session.clients.size === 0) {
      this.stopCapture(sessionId);
    }
  }

  /**
   * 停止捕获
   */
  stopCapture(sessionId: string) {
    const proc = this.captureProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.captureProcesses.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session && session.captureInterval) {
      clearInterval(session.captureInterval);
    }
  }
}

export const tmuxSyncService = new TmuxSyncService();
```

#### 4.2.3 移动端改造

**文件**：`frontend/src/lib/WorktreeConversationPanel.svelte`（修改）

```typescript
// 连接 TMUX 同步服务
let tmuxSyncWs: WebSocket | null = $state(null);

async function connectTmuxSync(worktreeId: string) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/tmux-sync/${worktreeId}`;

  tmuxSyncWs = new WebSocket(wsUrl);

  tmuxSyncWs.onmessage = (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'tmux_output') {
      // 收到 TMUX 输出，更新对话 UI
      handleTmuxOutput(message.messages);
    }
  };

  tmuxSyncWs.onclose = () => {
    // 断线重连
    setTimeout(() => connectTmuxSync(worktreeId), 3000);
  };
}

function handleTmuxOutput(messages: ParsedMessage[]) {
  // 将 TMUX 输出转换为对话 UI 格式
  for (const msg of messages) {
    const conversationMsg = {
      id: `tmux-${Date.now()}-${Math.random()}`,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      source: 'tmux',
    };

    conversationTimeline = [...conversationTimeline, conversationMsg];
  }
}

// 移动端发送消息到 TMUX
async function sendMessageFromMobile(content: string) {
  if (!tmuxSyncWs || tmuxSyncWs.readyState !== WebSocket.OPEN) {
    console.error('TMUX sync WebSocket not connected');
    return;
  }

  // 发送消息到 TMUX
  tmuxSyncWs.send(JSON.stringify({
    type: 'user_message',
    content,
    timestamp: Date.now(),
  }));

  // 同时添加到本地对话 UI
  const userMsg = {
    id: `mobile-${Date.now()}`,
    role: 'user',
    content,
    timestamp: Date.now(),
    source: 'mobile',
  };
  conversationTimeline = [...conversationTimeline, userMsg];

  // 显示"模型输出中..."提示
  isWaitingForResponse = true;
}
```

#### 4.2.4 后端路由

**文件**：`backend/src/server.ts`（修改）

```typescript
// TMUX 同步 WebSocket 端点
app.get('/api/tmux-sync/:worktreeId', (c) => {
  const worktreeId = c.req.param('worktreeId');
  const upgradeHeader = c.req.header('Upgrade');

  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket request', 400);
  }

  const { socket, response } = Bun.upgradeWebSocket(c.req.raw, {
    protocol: 'tmu-sync',
  });

  // 注册客户端
  tmuxSyncService.registerClient(worktreeId, socket);

  // 处理客户端消息
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'user_message') {
      // 将移动端消息发送到 TMUX
      await sendToTmux(worktreeId, message.content);
    }
  };

  socket.onclose = () => {
    tmuxSyncService.unregisterClient(worktreeId, socket);
  };

  return response;
});

async function sendToTmux(worktreeId: string, content: string): Promise<void> {
  // 获取 worktree 的 TMUX pane ID
  const worktree = await getWorktree(worktreeId);
  if (!worktree || !worktree.tmuxPaneId) {
    throw new Error('TMUX pane not found');
  }

  // 使用 tmux send-keys 发送消息
  await Bun.spawn([
    'tmux', 'send-keys',
    '-t', worktree.tmuxPaneId,
    content,
    'Enter',
  ]).exited;
}
```

### 4.3 优化方案：使用 Agent Hook 同步

上面的方案使用定期捕获 TMUX 输出，延迟较高（500ms）。更好的方案是使用 agent 的 hook 系统：

#### 4.3.1 修改 Agent Hook

**文件**：`backend/src/adapters/claude-cli.ts`（修改）

在 `ClaudeCliClient` 中增加 hook：

```typescript
export interface ClaudeCliOptions {
  command?: string;
  historyRoot?: string;
  hooks?: {
    onUserMessage?: (message: string) => void;
    onAssistantMessage?: (message: string) => void;
    onStreamDelta?: (delta: string) => void;
  };
}

class ClaudeCliClient {
  async startAgent(options: ClaudeCliOptions): Promise<void> {
    // ... 启动 agent ...

    // 如果配置了 hooks，通过 control.env 注册
    if (options.hooks) {
      await this.registerHooks(options.hooks);
    }
  }

  private async registerHooks(hooks: ClaudeCliOptions['hooks']): Promise<void> {
    // 写入 control.env，让 agent 加载我们的 hook
    const controlEnv = `
HOOK_USER_PROMPT_SUBMIT=/path/to/hook-handler.sh
HOOK_ASSISTANT_RESPONSE=/path/to/hook-handler.sh
HOOK_STREAM_DELTA=/path/to/hook-handler.sh
`;

    await Bun.write('/tmp/webmux-control.env', controlEnv);
  }
}
```

**文件**：`/path/to/hook-handler.sh`（新建）

```bash
#!/bin/bash
# Hook handler for real-time message sync

HOOK_TYPE="$1"
PAYLOAD="$2"

case "$HOOK_TYPE" in
  "user_prompt_submit")
    # 用户发送消息，推送到 WebSocket
    curl -X POST http://localhost:5111/api/internal/hook/user-message \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"$PAYLOAD\"}"
    ;;

  "assistant_response")
    # 助手回复，推送到 WebSocket
    curl -X POST http://localhost:5111/api/internal/hook/assistant-message \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"$PAYLOAD\"}"
    ;;

  "stream_delta")
    # 流式输出 delta，推送到 WebSocket
    curl -X POST http://localhost:5111/api/internal/hook/stream-delta \
      -H "Content-Type: application/json" \
      -d "{\"delta\": \"$PAYLOAD\"}"
    ;;
esac
```

#### 4.3.2 后端 Hook 处理

**文件**：`backend/src/server.ts`（修改）

```typescript
// 内部 Hook API（由 hook-handler.sh 调用）
app.post('/api/internal/hook/user-message', async (c) => {
  const { message, sessionId } = await c.req.json();

  // 广播给用户的所有客户端（包括移动端）
  broadcastToSessionClients(sessionId, {
    type: 'user_message',
    content: message,
    timestamp: Date.now(),
  });

  return c.json({ success: true });
});

app.post('/api/internal/hook/assistant-message', async (c) => {
  const { message, sessionId } = await c.req.json();

  broadcastToSessionClients(sessionId, {
    type: 'assistant_message',
    content: message,
    timestamp: Date.now(),
  });

  return c.json({ success: true });
});

app.post('/api/internal/hook/stream-delta', async (c) => {
  const { delta, sessionId } = await c.req.json();

  broadcastToSessionClients(sessionId, {
    type: 'message_delta',
    delta,
    timestamp: Date.now(),
  });

  return c.json({ success: true });
});
```

## 5. 其他细节

### 5.1 Custom Agent Claude-Compatible 配置

**已完成**：
- `packages/api-contract/src/schemas.ts`：定义 `CUSTOM_AGENT_DEFAULTS`、`CustomAgentCliStyleSchema`、`CustomAgentClaudeConfigSchema`
- `backend/src/domain/config.ts`：扩展 `CustomAgentConfig` 支持 `cliStyle` 和 `claude` 配置
- `frontend/src/lib/AgentEditorDialog.svelte`：展示 CLI style、command、history root、settings dir 配置

**待优化**：
- 前端表单验证：Claude-compatible agent 不需要 `startCommand` 和 `resumeCommand`
- 后端校验逻辑：`validateCustomAgentInput` 对 `cliStyle === "claude"` 跳过 `startCommand` 校验

### 5.2 CodeBuddy 兼容性

**已完成**：
- `backend/src/adapters/claude-cli.ts`：增加 CodeBuddy JSONL 格式解析
- `backend/src/services/agent-registry.ts`：内置 `codebuddy` agent 开启 `inAppChat`、`conversationHistory`、`interrupt` 能力
- `frontend/src/lib/WorktreeConversationPanel.svelte`：移除硬编码，根据 `worktree.agentName !== null` 判断是否支持 chat

**待修复**：
- CodeBuddy 的 `stream-json` 输出格式可能与 Claude 不完全一致，需要测试并调整解析逻辑
- Hook 404 问题：`control.env` 中的 `WEBMUX_CONTROL_URL` 需要动态设置为当前服务的端口

### 5.3 移动端流式输出

**设计方案**：

移动端发送消息时，后端直接调用 `claude/codebuddy -p --output-format stream-json`，然后把 stdout delta 推给前端 WebSocket。

**实现步骤**：

1. 后端增加 `/api/agents/:agentId/stream-chat` 端点
2. 前端 WebSocket 处理 `message_delta` 事件
3. 实时更新对话 UI

**文件**：`backend/src/services/stream-chat-service.ts`（新建）

```typescript
export async function streamChat(
  agentId: string,
  message: string,
  worktreeId: string,
  onDelta: (delta: string) => void,
  onComplete: (result: any) => void,
): Promise<void> {
  const agent = await getAgent(agentId);

  const proc = Bun.spawn({
    cmd: [
      agent.claude?.command || 'claude',
      '-p',
      '--output-format', 'stream-json',
      '--max-turns', '1',
      message,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PROJECT_ROOT: getWorktreePath(worktreeId),
    },
  });

  let buffer = '';
  const reader = proc.stdout.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += new TextDecoder().decode(value);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        if (event.type === 'content_block_delta') {
          const delta = event.delta?.text || '';
          onDelta(delta);
        }

        if (event.type === 'result') {
          onComplete(event);
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}
```

## 6. 实施计划

### Phase 1: 基础功能（1-2 天）
- [ ] 实现 `parseStreamJsonUsage` 和 `formatContextDisplay`
- [ ] 修改 `agent-chat-service.ts` 推送 token usage
- [ ] 前端展示 context 用量

### Phase 2: Slash Command 发现（2-3 天）
- [ ] 实现 `slash-command-discovery.ts`
- [ ] 新增 `/api/agents/:agentId/slash-commands` 端点
- [ ] 前端集成 slash command 自动补全

### Phase 3: 消息同步（3-5 天）
- [ ] 实现 `tmux-sync-service.ts`（定期捕获方案）
- [ ] 后端增加 `/api/tmux-sync/:worktreeId` WebSocket 端点
- [ ] 移动端连接 TMUX 同步服务
- [ ] 测试并优化同步延迟

### Phase 4: 优化和测试（2-3 天）
- [ ] 实现 hook-based 同步方案（降低延迟）
- [ ] 修复 CodeBuddy 兼容性问题
- [ ] 完善错误处理和日志
- [ ] 编写测试用例

## 7. 参考资料

- [Vibe-kanban Slash Commands](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/claude/slash_commands.rs)
- [Claude Code Stream JSON Format](https://docs.anthropic.com/claude-code/stream-json)
- [TMUX Capture Pane](https://man.openbsd.org/tmux.1#capture-pane)
- [WebMux Architecture](./architecture.svg)

## 8. 附录：完整类型定义

```typescript
// packages/api-contract/src/types.ts

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model_context_window?: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  type: 'builtin' | 'skill' | 'custom';
  source?: string;
}

export interface TmuxSyncMessage {
  type: 'tmux_output' | 'user_message' | 'assistant_message' | 'message_delta';
  messages?: ParsedMessage[];
  content?: string;
  delta?: string;
  timestamp: number;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  source?: 'tmux' | 'mobile' | 'web';
}
```
