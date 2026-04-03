# power-pi

Custom pi extensions.

This repo is now a pnpm workspace monorepo:

- install the root package to load every extension
- install any folder under `extensions/` to load just that extension
- see [`extensions/README.md`](extensions/README.md) for per-package install paths

**Note:** Uses `pnpm`. To install dependencies from this repo:

```bash
pnpm install
```

## Extensions

- **ask-user-question** — interactive forms for structured user input
- **btw** — side-question command (`/btw`)
- **clear** — fresh session command (`/clear`, `Ctrl+L`)
- **multi-edit** — enhanced `edit` tool with batch edits and patch support
- **review** — review a GitHub PR or GitLab MR URL and then inspect/submit it in a side pane (`/review <url>`, `/review-tui`)
- **status-line** — shows git branch and richer runtime stats in the footer
- **team-mode** — background multi-agent team orchestration

## btw

The `btw` extension adds Claude Code-style `/btw` behavior to pi for asking a quick side question while pi is busy with the main task.

### What it does

- asks a one-off side question with `/btw <question>`
- uses the active pi model and current session transcript as context
- runs independently from the main agent loop, so it works while pi is still busy
- shows the answer in a passive widget below the editor instead of interrupting the current UI
- keeps the answer out of the visible transcript and out of future LLM context
- persists the question/answer as hidden custom session metadata

### Install

Install everything from the repo root:

```bash
pi install npm:@power-pi
```

Or install only `btw`:

```bash
pi install npm:pi-btw
```

Or load it directly for testing:

```bash
pi -e npm:pi-btw/index.ts
```

### Usage

```text
/btw What does this error mean?
/btw Give me a shorter name for this function
/btw Summarize the current approach in one paragraph
```

### Behavior

- If pi is idle, `/btw` asks the side question immediately.
- If pi is busy, `/btw` still works because it makes a separate model call instead of waiting for the main agent turn to finish.
- The result appears in a passive widget below the editor while the main agent keeps running.
- Completed answers expire automatically after a short time.
- `Ctrl+Shift+B` asks the current editor text as a side question.

### Notes

- `/btw` is implemented by intercepting raw input that starts with `/btw`, not by registering a normal extension command.
- This avoids pi's normal queued command behavior and makes it closer to Claude Code's side-question flow.
- Hidden history is stored through `pi.appendEntry()` using custom session entries, so it does not affect future model context.

## review

The `review` extension adds both `/review` and `/review-tui`.

### Usage

```text
/review https://github.com/org/repo/pull/123
/review https://gitlab.com/group/project/-/merge_requests/45
/review-tui
```

### Behavior

- `/review <url>` detects GitHub vs GitLab from the URL
- fetches the diff under the hood with the appropriate CLI
- runs the review with the active pi model
- prints the review summary in the terminal
- stores the review for `/review-tui`
- `/review-tui` opens the saved review in a side pane
- lets you approve, dismiss, or edit each comment
- submits approved comments directly to GitHub or GitLab based on the saved review URL

## clear

The `clear` extension adds a `/clear` command that starts a fresh session, similar to the built-in `/new`.

### Usage

```text
/clear
```

Or press `Ctrl+L` for the keyboard shortcut.

### Behavior

- If the agent is busy, `/clear` waits for it to finish before switching sessions.
- Creates a brand new session via `ctx.newSession()`, same as `/new`.
- Can be cancelled by other extensions via the `session_before_switch` event.
