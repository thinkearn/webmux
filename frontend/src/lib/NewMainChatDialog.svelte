<script lang="ts">
  import type { AgentId, AgentSummary, BuiltInAgentId, CreateMainChatRequest } from "./types";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    agents = [],
    defaultAgentId = "claude",
    activeAgentIds = [],
    oncreate,
    oncancel,
  }: {
    agents?: AgentSummary[];
    defaultAgentId?: BuiltInAgentId;
    activeAgentIds?: AgentId[];
    oncreate: (request: CreateMainChatRequest) => void;
    oncancel: () => void;
  } = $props();

  let fallbackAgentId = $derived(
    agents.find((agent) => agent.id === defaultAgentId && !activeAgentIds.includes(agent.id))?.id
      ?? agents.find((agent) => !activeAgentIds.includes(agent.id))?.id
      ?? "",
  );
  let selectedAgentId = $state<AgentId>("");
  let prompt = $state("");
  let submitting = $state(false);

  $effect(() => {
    if (!selectedAgentId && fallbackAgentId) {
      selectedAgentId = fallbackAgentId;
    }
  });

  function handleSubmit(event: Event): void {
    event.preventDefault();
    if (!selectedAgentId || submitting) return;
    submitting = true;
    oncreate({
      agent: selectedAgentId,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    });
  }
</script>

<BaseDialog onclose={oncancel}>
  <form class="flex flex-col gap-4" onsubmit={handleSubmit}>
    <div>
      <h2 class="text-base font-semibold">New Chat</h2>
      <p class="mt-1 text-xs text-muted">Start an agent in the project root without creating a worktree.</p>
    </div>

    <label class="flex flex-col gap-1.5 text-sm">
      <span class="text-muted">Agent</span>
      <select
        bind:value={selectedAgentId}
        class="h-9 rounded-md border border-edge bg-surface px-2 text-primary"
        disabled={submitting}
      >
        {#each agents as agent (agent.id)}
          <option value={agent.id} disabled={activeAgentIds.includes(agent.id)}>
            {agent.label}{activeAgentIds.includes(agent.id) ? " (running)" : ""}
          </option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col gap-1.5 text-sm">
      <span class="text-muted">Initial prompt (optional)</span>
      <textarea
        bind:value={prompt}
        class="min-h-[6rem] rounded-md border border-edge bg-surface px-3 py-2 text-sm text-primary"
        placeholder="Describe what you want the agent to do"
        disabled={submitting}
      ></textarea>
    </label>

    <div class="flex justify-end gap-2">
      <Btn variant="ghost" type="button" onclick={oncancel} disabled={submitting}>Cancel</Btn>
      <Btn variant="accent" type="submit" disabled={submitting || !selectedAgentId || activeAgentIds.includes(selectedAgentId)}>
        {submitting ? "Starting..." : "Start Chat"}
      </Btn>
    </div>
  </form>
</BaseDialog>
