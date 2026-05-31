<script lang="ts">
  import type { TmuxLayoutSnapshot } from "./types";

  function formatWindowLabel(name: string): string {
    return name.startsWith("wm-") ? name.slice(3) : name;
  }

  let {
    layout = null,
    onsplit,
    onnewwindow,
    onselectwindow,
    onselectpane,
  }: {
    layout?: TmuxLayoutSnapshot | null;
    onsplit: (split: "right" | "bottom") => void;
    onnewwindow: () => void;
    onselectwindow: (windowName: string) => void;
    onselectpane: (paneIndex: number) => void;
  } = $props();
</script>

<div class="shrink-0 border-b border-edge bg-sidebar px-3 py-2 flex flex-col gap-2">
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-[11px] font-medium text-muted shrink-0">Windows</span>
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {#if layout}
        {#each layout.windows as window (window.name)}
          <button
            type="button"
            class="max-w-[12rem] truncate rounded-md border px-2 py-1 text-[11px] cursor-pointer {window.active
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-edge bg-surface text-primary hover:bg-hover'}"
            title={window.name}
            onclick={() => onselectwindow(window.name)}
          >
            {formatWindowLabel(window.name)}
          </button>
        {/each}
      {:else}
        <span class="text-[11px] text-muted">Connecting tmux…</span>
      {/if}
    </div>
    <button
      type="button"
      class="shrink-0 rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-accent hover:bg-hover cursor-pointer"
      onclick={onnewwindow}
      disabled={!layout}
    >
      + Window
    </button>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <span class="text-[11px] font-medium text-muted shrink-0">Panes</span>
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {#if layout}
        {#each layout.panes as pane (pane)}
          <button
            type="button"
            class="min-w-7 rounded-md border px-2 py-1 text-[11px] cursor-pointer {layout.activePane === pane
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-edge bg-surface text-primary hover:bg-hover'}"
            onclick={() => onselectpane(pane)}
          >
            {pane + 1}
          </button>
        {/each}
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        class="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-primary hover:bg-hover cursor-pointer disabled:opacity-50"
        onclick={() => onsplit("bottom")}
        disabled={!layout}
        title="Split pane horizontally"
      >
        Split ↓
      </button>
      <button
        type="button"
        class="rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-primary hover:bg-hover cursor-pointer disabled:opacity-50"
        onclick={() => onsplit("right")}
        disabled={!layout}
        title="Split pane vertically"
      >
        Split →
      </button>
    </div>
  </div>
</div>
