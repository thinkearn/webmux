<script lang="ts">
  let {
    mode,
    onchange,
  }: {
    mode: "chat" | "terminal";
    onchange: (mode: "chat" | "terminal") => void;
  } = $props();
</script>

<div
  class="shrink-0 flex items-center justify-center gap-2 border-b border-edge bg-surface px-4 py-2"
  role="tablist"
  aria-label="Session view"
>
  <div class="inline-flex rounded-md border border-edge p-0.5 bg-sidebar">
    <button
      type="button"
      role="tab"
      aria-selected={mode === "chat"}
      class="min-w-24 rounded px-3 py-1.5 text-xs font-medium cursor-pointer border-none transition-colors {mode === 'chat'
        ? 'bg-accent text-white'
        : 'bg-transparent text-muted hover:text-primary hover:bg-hover'}"
      onclick={() => onchange("chat")}
    >
      Chat
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={mode === "terminal"}
      class="min-w-24 rounded px-3 py-1.5 text-xs font-medium cursor-pointer border-none transition-colors {mode === 'terminal'
        ? 'bg-accent text-white'
        : 'bg-transparent text-muted hover:text-primary hover:bg-hover'}"
      onclick={() => onchange("terminal")}
    >
      Terminal
    </button>
  </div>
</div>
