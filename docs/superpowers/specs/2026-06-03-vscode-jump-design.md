# VS Code Jump

Add a "VS Code" jump button alongside the existing "Cursor" button, using the `vscode://` URL scheme to open directories in VS Code.

## URL Construction

New function `makeVscodeUrl(dir, sshHost)` in `utils.ts`, mirroring `makeCursorUrl`:

- Local: `vscode://file<path>`
- Remote SSH: `vscode://vscode-remote/ssh-remote+<host><path>`
- Returns `null` when `dir` is falsy

SSH host is shared with Cursor — no new settings.

## UI

- New `VscodeButton.svelte` component — identical to `CursorButton.svelte`, labeled "VS Code", tooltip "Open in VS Code".
- Both buttons appear side by side in all three current locations:
  - `DiffDialog.svelte` header
  - `RepoGroup.svelte` (top bar)
  - `SidebarRepoRow.svelte`

## Data Flow

`App.svelte` and `TopBar.svelte` compute both `cursorUrl` and `vscodeUrl` and pass them as parallel props through the component tree.

## Types

`DiffDialogProps` gains `vscodeUrl?: string | null`.

## Tests

`DiffDialog.test.ts` updated to assert the VS Code link renders with the correct `href`.
