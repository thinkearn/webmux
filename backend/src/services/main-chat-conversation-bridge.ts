import {
  mainChatMetaAsWorktreeMeta,
  readMainChatMeta,
  writeMainChatMeta,
} from "../adapters/fs";
import type { WorktreeMeta } from "../domain/model";
import {
  ClaudeConversationService,
  type ClaudeConversationServiceDependencies,
} from "./claude-conversation-service";
import {
  WorktreeConversationService,
  type WorktreeConversationServiceDependencies,
} from "./worktree-conversation-service";

export interface MainChatMetaStore {
  readMeta: (gitDir: string) => Promise<WorktreeMeta | null>;
  writeMeta: (gitDir: string, meta: WorktreeMeta) => Promise<void>;
}

export function createMainChatMetaStore(
  projectGitDir: string,
  agentId: string,
  mainBranch: string,
): MainChatMetaStore {
  return {
    readMeta: async (_gitDir: string) => {
      const meta = await readMainChatMeta(projectGitDir, agentId);
      return meta ? mainChatMetaAsWorktreeMeta(meta, mainBranch) : null;
    },
    writeMeta: async (_gitDir: string, worktreeMeta: WorktreeMeta) => {
      const meta = await readMainChatMeta(projectGitDir, agentId);
      if (!meta) return;
      await writeMainChatMeta(projectGitDir, {
        ...meta,
        conversation: worktreeMeta.conversation ?? null,
      });
    },
  };
}

export function createMainChatWorktreeConversationService(
  deps: WorktreeConversationServiceDependencies,
  metaStore: MainChatMetaStore,
): WorktreeConversationService {
  return new WorktreeConversationService({
    ...deps,
    readMeta: metaStore.readMeta,
    writeMeta: metaStore.writeMeta,
  });
}

export function createMainChatClaudeConversationService(
  deps: ClaudeConversationServiceDependencies,
  metaStore: MainChatMetaStore,
): ClaudeConversationService {
  return new ClaudeConversationService({
    ...deps,
    readMeta: metaStore.readMeta,
    writeMeta: metaStore.writeMeta,
  });
}
