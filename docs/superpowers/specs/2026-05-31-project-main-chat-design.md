# Project Main Chat Design

## Summary

Add "New Chat" to run one agent session per agent type in the project root directory, without creating a worktree or branch.

## Constraints

- One active main chat per agent ID (codex, claude, custom agents are independent)
- CWD is `PROJECT_DIR`; no git worktree operations
- Close kills tmux window; Remove clears persisted meta
- Reuse existing in-app chat (attach/history/send/interrupt + websocket stream)
- Frontend: special sidebar rows; CLI parity via `webmux chat` subcommands

## Storage

`.git/webmux/main-chats/<agentId>/meta.json`, `runtime.env`, `control.env`

## IDs

- Chat id: `main-chat:<agentId>`
- Tmux window: `wm-main-chat-<agentId>`

## API

- `GET /api/main-chats`
- `POST /api/main-chats`
- `POST /api/main-chats/:agentId/close`
- `DELETE /api/main-chats/:agentId`
- Conversation endpoints mirror worktree agents API under `/api/agents/main-chats/:agentId/...`
- WebSocket: `/ws/agents/main-chats/:agentId`
