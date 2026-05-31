# Paste Image in Worktree Creation Dialog

## Problem

Users can paste images into the terminal (where an agent is already running), but cannot paste images when creating a new worktree. The prompt textarea in `CreateWorktreeDialog` has no image paste support.

## Solution

Allow image paste (clipboard) and drag-and-drop in the worktree creation dialog's prompt textarea. Images are uploaded to a staging area via a new backend endpoint, and the returned file paths are appended to the prompt text.

## Backend

### New endpoint: `POST /api/uploads`

Staging upload endpoint that does not require an existing worktree.

**Request**: Multipart form data with a `files` field (same as `POST /api/worktrees/:name/upload`).

**Validation**: Reuse existing `ALLOWED_IMAGE_TYPES`, `MAX_FILE_SIZE`, and `sanitizeFilename` logic.

**Storage**: Files written to `/tmp/webmux-uploads/_staging/<uuid>/<timestamp>_<sanitized-name>`.

**Response**: `{ files: Array<{ path: string }> }` — identical shape to the existing upload endpoint.

**Route**: Registered in `server.ts` alongside the existing upload route.

### Cleanup

Orphaned staging files are acceptable for now. The `/tmp` filesystem is cleared on reboot, and a TTL-based janitor can be added later if needed.

## Frontend

### API layer (`frontend/src/lib/api.ts`)

Add `uploadStagingFiles(files: File[]): Promise<FileUploadResult>` that POSTs to `/api/uploads`.

Reuses the existing `FileUploadResult` type.

### CreateWorktreeDialog (`frontend/src/lib/CreateWorktreeDialog.svelte`)

- **Paste**: Add `paste` event listener on the prompt textarea (capture phase). Extract `File` items with `type.startsWith("image/")` from `ClipboardEvent.clipboardData`. Call `uploadStagingFiles()`, append returned paths to the `prompt` value.
- **Drag-and-drop**: Add `dragover`, `dragleave`, `drop` handlers on the form/dialog. Extract image files from `DataTransfer`. Same upload-and-append flow.

No changes to `CreateWorktreeRequest` schema — file paths are just part of the prompt string.

## Files Changed

| File | Change |
|------|--------|
| `backend/src/server.ts` | Add `apiUploadStagingFiles` handler + route |
| `frontend/src/lib/api.ts` | Add `uploadStagingFiles` function |
| `frontend/src/lib/CreateWorktreeDialog.svelte` | Add paste + drop handlers on prompt textarea |

## Out of Scope

- Image preview thumbnails in the dialog
- Staging file cleanup/janitor
- Non-image file uploads
