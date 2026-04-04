# pi-mono-grep

## 1.1.0

### Minor Changes

- Add context-guard and grep extensions; improve multi-edit with dedup

  **New: `pi-mono-context-guard`**
  Extension that keeps the LLM context window lean with three guards:

  - `read` without `limit` → auto-injects `limit=120`
  - Read dedup → mtime-based stub for unchanged files (~20 tokens vs full content re-send)
  - `bash` with unbounded `rg` → appends `| head -60`

  Listens to `context-guard:file-modified` events to invalidate the dedup cache after edits.
  `/context-guard` command to inspect and toggle guards at runtime.

  **New: `pi-mono-grep`**
  Dedicated ripgrep wrapper tool. Replaces raw `rg` in bash with a structured tool that has
  `head_limit=60` built into the schema, `output_mode` (files_with_matches / content / count),
  pagination via `offset`, and automatic VCS directory exclusions.
  Prompt guidelines instruct the model to always use `grep` instead of bash+rg.

  **Updated: `pi-mono-multi-edit`**

  - Per-call read cache in `createRealWorkspace` deduplicates disk reads within a single `execute()` invocation (preflight + real-apply)
  - Emits `context-guard:file-modified` event after every real `writeText` and `deleteFile` so context-guard can evict stale dedup cache entries
