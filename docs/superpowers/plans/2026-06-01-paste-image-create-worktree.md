# Paste Image in Worktree Creation Dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to paste or drag-and-drop images into the worktree creation dialog's prompt textarea, uploading them to a staging area and embedding the file paths in the prompt.

**Architecture:** A new backend staging upload endpoint (`POST /api/uploads`) accepts images without requiring an existing worktree. The frontend dialog adds paste/drop handlers that upload via this endpoint and append returned paths to the prompt text.

**Tech Stack:** Bun (backend), Svelte 5 runes (frontend), existing multipart upload infrastructure.

---

### Task 1: Backend — Add staging upload endpoint

**Files:**
- Modify: `backend/src/server.ts:1866-1904` (reference existing `apiUploadFiles`)
- Modify: `backend/src/server.ts:2256-2263` (add route)

- [ ] **Step 1: Write the staging upload handler**

Add this function directly below the existing `apiUploadFiles` function (after line 1904):

```typescript
async function apiUploadStagingFiles(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("Invalid multipart form data", 400);
  }

  const entries = formData.getAll("files");
  if (entries.length === 0) return errorResponse("No files provided", 400);

  const stagingId = randomUUID();
  const uploadDir = `/tmp/webmux-uploads/_staging/${stagingId}`;
  mkdirSync(uploadDir, { recursive: true });

  const results: Array<{ path: string }> = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (!ALLOWED_IMAGE_TYPES.has(entry.type)) {
      return errorResponse(`Unsupported file type: ${entry.type}`, 400);
    }
    if (entry.size > MAX_FILE_SIZE) {
      return errorResponse(`File too large: ${entry.name} (max 10MB)`, 400);
    }
    const safeName = `${Date.now()}_${sanitizeFilename(entry.name)}`;
    const destPath = join(uploadDir, safeName);
    if (!resolve(destPath).startsWith(uploadDir + "/")) {
      return errorResponse("Invalid filename", 400);
    }
    await Bun.write(destPath, entry);
    results.push({ path: destPath });
  }

  log.info(`[upload-staging] stagingId=${stagingId} files=${results.length}`);
  return jsonResponse({ files: results });
}
```

- [ ] **Step 2: Register the route**

In the route map (near line 2256, alongside the existing upload route), add:

```typescript
"/api/uploads": {
  POST: (req) => {
    return catching("POST /api/uploads", () => apiUploadStagingFiles(req));
  },
},
```

- [ ] **Step 3: Verify manually**

Start the backend (`source "$(git rev-parse --git-dir)/webmux/runtime.env" && cd backend && bun run dev`), then test with curl:

```bash
curl -X POST http://localhost:5141/api/uploads -F "files=@/path/to/some/image.png"
```

Expected: `{"files":[{"path":"/tmp/webmux-uploads/_staging/<uuid>/<timestamp>_image.png"}]}`

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat: add staging upload endpoint for pre-worktree image uploads"
```

---

### Task 2: Frontend — Add `uploadStagingFiles` to API layer

**Files:**
- Modify: `frontend/src/lib/api.ts:351` (add after `uploadFiles`)

- [ ] **Step 1: Add the function**

Append after the `uploadFiles` function (after line 351):

```typescript
export async function uploadStagingFiles(files: File[]): Promise<FileUploadResult> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  const res = await fetch("/api/uploads", {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as FileUploadResult;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add uploadStagingFiles API function"
```

---

### Task 3: Frontend — Add paste and drag-drop handlers to CreateWorktreeDialog

**Files:**
- Modify: `frontend/src/lib/CreateWorktreeDialog.svelte`

- [ ] **Step 1: Add import**

At the top of the `<script>` block, add `uploadStagingFiles` to the imports. After the existing imports (around line 1-16), add:

```typescript
import { uploadStagingFiles } from "./api";
```

- [ ] **Step 2: Add state for upload status and drag indicator**

After the existing state declarations (around line 165), add:

```typescript
let isUploading = $state(false);
let isDraggingOver = $state(false);
let dragCounter = 0;
```

- [ ] **Step 3: Add paste handler**

Add these functions after the state declarations:

```typescript
async function handlePromptPaste(e: ClipboardEvent): Promise<void> {
  const clipboard = e.clipboardData;
  if (!clipboard) return;

  const imageFiles: File[] = [];
  for (const item of clipboard.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length === 0) return;

  e.preventDefault();
  await uploadAndAppendPaths(imageFiles);
}

async function uploadAndAppendPaths(files: File[]): Promise<void> {
  try {
    isUploading = true;
    const result = await uploadStagingFiles(files);
    const paths = result.files.map((f) => f.path).join(" ");
    if (paths) {
      prompt = prompt ? `${prompt}\n${paths}` : paths;
    }
  } catch {
    /* ignore upload errors in dialog */
  } finally {
    isUploading = false;
  }
}

function handlePromptDragEnter(e: DragEvent): void {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const hasImages = Array.from(dt.items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  if (hasImages) {
    dragCounter++;
    isDraggingOver = true;
  }
}

function handlePromptDragOver(e: DragEvent): void {
  e.preventDefault();
}

function handlePromptDragLeave(): void {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDraggingOver = false;
  }
}

async function handlePromptDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  dragCounter = 0;
  isDraggingOver = false;

  const dt = e.dataTransfer;
  if (!dt) return;

  const files = Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;

  await uploadAndAppendPaths(files);
}
```

- [ ] **Step 4: Wire up events on the textarea**

Replace the textarea element (around lines 283-298) with:

```svelte
<div class="relative">
  <textarea
    id="wt-prompt"
    rows="4"
    use:focus
    class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent resize-y {isDraggingOver ? 'border-accent ring-1 ring-accent/30' : ''}"
    placeholder={createLinearTicket
      ? "Describe the task for the agent. This will also be used as the Linear ticket description..."
      : "Describe the task for the agent..."}
    bind:value={prompt}
    disabled={isUploading}
    onpaste={handlePromptPaste}
    ondragenter={handlePromptDragEnter}
    ondragover={handlePromptDragOver}
    ondragleave={handlePromptDragLeave}
    ondrop={handlePromptDrop}
    onkeydown={(e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      }
    }}
  ></textarea>
  {#if isDraggingOver}
    <div class="absolute inset-0 flex items-center justify-center rounded-md bg-surface/80 pointer-events-none">
      <span class="text-xs text-muted">Drop image(s) to upload</span>
    </div>
  {/if}
  {#if isUploading}
    <div class="absolute inset-0 flex items-center justify-center rounded-md bg-surface/80 pointer-events-none">
      <span class="text-xs text-muted">Uploading...</span>
    </div>
  {/if}
</div>
```

- [ ] **Step 5: Verify manually**

Start both frontend and backend. Open the create worktree dialog, paste an image into the prompt textarea. Verify:
1. The image is uploaded to `/tmp/webmux-uploads/_staging/`
2. The file path appears in the prompt text
3. Drag-and-drop also works
4. Creating the worktree sends the prompt with the path included

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/CreateWorktreeDialog.svelte
git commit -m "feat: add image paste and drag-drop support to worktree creation dialog"
```
