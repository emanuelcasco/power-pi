/**
 * Pi Teams — Leader Runtime
 *
 * In-process orchestration engine for Pi Teams.
 *
 * The leader runtime is intentionally orchestration-only:
 * - it creates and assigns tasks
 * - it tracks phases and dependencies
 * - it spawns isolated teammate pi subprocesses for execution
 * - it emits summary / milestone / error signals
 *
 * The leader itself never executes code directly. All implementation work is
 * delegated to teammates spawned as separate pi processes with self-contained
 * prompts.
 */

import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

import type {
  LeaderPhase,
  LeaderProcess,
  TaskRecord,
  TeamRecord,
  TeammateProcess,
} from "../core/types.js";
import { TEAMMATE_ROLE_PROMPTS, TEAM_TEMPLATES } from "../core/types.js";
import type { TeamStore } from "../core/store.js";
import type { SignalManager } from "../managers/signal-manager.js";
import type { TaskManager } from "../managers/task-manager.js";
import type { MailboxManager } from "../managers/mailbox-manager.js";
import type { TeamManager } from "../managers/team-manager.js";

const LEADER_POLL_MS = 5_000;

/**
 * Teammate roles that perform write operations.
 * These roles get dedicated git worktrees for filesystem isolation
 * when parallel execution on the same repo is needed.
 */
const WRITE_CAPABLE_ROLES = new Set(["backend", "frontend", "tester", "docs"]);

/**
 * Allocate a dedicated git worktree for a teammate at `worktreePath`.
 * Returns the allocated path on success, or `null` if git is not available
 * or the cwd is not inside a git repository — callers should fall back to
 * the shared working directory gracefully.
 */
async function createWorktree(repoRoot: string, worktreePath: string): Promise<string | null> {
  try {
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
    await execFile("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    return worktreePath;
  } catch {
    // git not available, not a repo, or worktree already exists — fall back silently
    return null;
  }
}

/**
 * Remove a previously-allocated git worktree.
 * Best-effort: silently ignores errors (e.g. already removed).
 */
async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await execFile("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      timeout: 30_000,
    });
  } catch {
    // ignore — worktree may already be removed or git unavailable
  }
}

type ActiveLeader = {
  proc?: ChildProcess;
  abortController: AbortController;
  interval: ReturnType<typeof setInterval>;
};

type ActiveTeammate = {
  proc: ChildProcess;
  abortController: AbortController;
};

type ParsedHandoff = {
  to: string;
  message: string;
};

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptToTempFile(
  prefix: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `pi-teams-${prefix}-`),
  );
  const filePath = path.join(dir, "prompt.md");
  await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

type PiProcessResult = { output: string; exitCode: number | null };

/**
 * Collect the final assistant text from a pi subprocess running in JSON mode.
 * Handles buffered line splitting and pi JSON event parsing.
 * Resolves when the process closes with the output text and exit code.
 */
function collectPiOutput(proc: ChildProcess): Promise<PiProcessResult> {
  let buffer = "";
  let output = "";

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content ?? [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) output = text;
      }
    } catch { /* ignore malformed lines */ }
  };

  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
  });

  return new Promise<PiProcessResult>((resolve) => {
    proc.on("close", (code) => {
      if (buffer.trim()) parseLine(buffer);
      resolve({ output, exitCode: code });
    });
    proc.on("error", () => resolve({ output: "", exitCode: 1 }));
  });
}

/** Spawn a one-shot pi subprocess in JSON mode with an appended system prompt. */
function spawnPiJsonMode(promptFilePath: string, userMessage: string, cwd: string): ChildProcess {
  const args = [
    "--mode", "json", "-p", "--no-session",
    "--append-system-prompt", promptFilePath,
    userMessage,
  ];
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    // Fix #1: prevent subprocess from launching its own leader instances
    env: { ...process.env, PI_TEAM_SUBPROCESS: "1" },
  });
}

function safeKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildTaskPrompt(task: TaskRecord): string {
  const lines = [task.title];
  if (task.description) lines.push(task.description);
  if (task.artifacts.length > 0)
    lines.push(`Artifacts to produce or update: ${task.artifacts.join(", ")}`);
  if (task.blockers.length > 0)
    lines.push(`Known blockers: ${task.blockers.join("; ")}`);
  return lines.join("\n\n");
}

function roleDisplay(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function summarizeCompletionOutput(output: string, fallback: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^#+\s*/.test(line) &&
        !/^(what was accomplished|files created or modified|issues or open questions|handoff notes(?: for other teammates)?|handoffs?)\s*:?$/i.test(
          line,
        ),
    );

  if (lines.length === 0) return fallback;
  return lines.slice(0, 2).join(" ").slice(0, 500);
}

function parseExplicitHandoffs(
  output: string,
  teammates: string[],
  sender: string,
): ParsedHandoff[] {
  const validRecipients = new Set(teammates.filter((role) => role !== sender));
  const lines = output.split(/\r?\n/);
  const handoffs: ParsedHandoff[] = [];
  let inHandoffSection = false;

  const maybeAdd = (recipient: string, message: string) => {
    const to = recipient.trim();
    const text = message.trim();
    if (!to || !text || !validRecipients.has(to)) return;
    handoffs.push({ to, message: text });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inHandoffSection) continue;
      continue;
    }

    if (
      /^(?:#{1,6}\s*)?handoff notes(?: for other teammates)?\s*:?$/i.test(
        line,
      ) ||
      /^(?:#{1,6}\s*)?handoffs\s*:?$/i.test(line) ||
      /^4\.\s*handoff notes(?: for other teammates)?\s*:?$/i.test(line)
    ) {
      inHandoffSection = true;
      continue;
    }

    if (inHandoffSection && /^(?:#{1,6}\s*|##\s*|###\s*)/.test(line)) {
      break;
    }

    const normalized = line.replace(/^[-*]\s*/, "");

    let match = normalized.match(
      /^to\s*:\s*([a-z0-9_-]+)\s*\|\s*message\s*:\s*(.+)$/i,
    );
    if (match) {
      maybeAdd(match[1], match[2]);
      continue;
    }

    match = normalized.match(/^([a-z0-9_-]+)\s*:\s*(.+)$/i);
    if (inHandoffSection && match) {
      maybeAdd(match[1], match[2]);
      continue;
    }

    match = normalized.match(/^handoff to\s+([a-z0-9_-]+)\s*:\s*(.+)$/i);
    if (match) {
      maybeAdd(match[1], match[2]);
    }
  }

  const merged = new Map<string, string[]>();
  for (const handoff of handoffs) {
    const existing = merged.get(handoff.to) ?? [];
    existing.push(handoff.message);
    merged.set(handoff.to, existing);
  }

  return [...merged.entries()].map(([to, messages]) => ({
    to,
    message: messages.join(" "),
  }));
}

/** Maximum number of times a stalled task is retried before being permanently cancelled. */
const MAX_TASK_RETRIES = 3;

/**
 * Minimum time (ms) a task must have been `in_progress` before it can be
 * declared stalled. Prevents false positives on the same leader-cycle that
 * spawned the teammate subprocess.
 */
const STALL_GRACE_MS = LEADER_POLL_MS * 2;

export class LeaderRuntime {
  private activeLeaders = new Map<string, ActiveLeader>();
  private activeTeammates = new Map<string, ActiveTeammate>();
  /** Per-team mailbox cursor: tracks how many messages have been processed by the leader. */
  private lastMailboxCount = new Map<string, number>();
  /** Fix #4: guard against concurrent runLeaderCycle executions for the same team. */
  private readonly cycleRunning = new Set<string>();

  constructor(
    private store: TeamStore,
    private teamManager: TeamManager,
    private taskManager: TaskManager,
    private signalManager: SignalManager,
    private mailboxManager: MailboxManager,
  ) {}

  async launchLeader(teamId: string): Promise<void> {
    if (this.activeLeaders.has(teamId)) return;

    // Claim the slot immediately to prevent concurrent launches (TOCTOU guard).
    const abortController = new AbortController();
    const leader: ActiveLeader = {
      abortController,
      interval: undefined as unknown as ReturnType<typeof setInterval>,
    };
    this.activeLeaders.set(teamId, leader);

    try {
      let team = await this.store.loadTeam(teamId);
      if (!team) throw new Error(`Team not found: ${teamId}`);

      if (team.teammates.length === 0) {
        const roles = await this.planTeamComposition(team);
        await this.store.ensureTeamDirs(teamId, roles);
        team = await this.teamManager.updateTeam(teamId, { teammates: roles });
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "team_summary",
          severity: "info",
          message: `Leader planned team composition: ${roles.join(", ")}`,
          links: [],
        });
      }

      const now = new Date().toISOString();
      const leaderState: LeaderProcess = {
        teamId,
        state: "running",
        startedAt: now,
      };
      await this.store.saveLeaderProcess(teamId, leaderState);

      await this.teamManager.updateTeam(teamId, {
        status: "running",
        currentPhase: team.currentPhase ?? this.initialPhaseFor(team),
        summary:
          team.summary ?? `Leader started for objective: ${team.objective}`,
      });

      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_summary",
        severity: "info",
        message: `Leader started — objective: ${team.objective}`,
        links: [],
      });

      // Persist the leader prompt for debuggability / transcript inspection.
      try {
        const promptDir = path.join(this.store.getTeamDir(teamId), "leader");
        await fs.promises.mkdir(promptDir, { recursive: true });
        await writeFile(
          path.join(promptDir, "prompt.md"),
          this.buildLeaderPrompt(team),
          "utf8",
        );
      } catch {
        // best effort only
      }

      leader.interval = setInterval(() => {
        void this.runLeaderCycle(teamId);
      }, LEADER_POLL_MS);

      await this.ensureBootstrapTasks(teamId);
      await this.runLeaderCycle(teamId);
    } catch (err) {
      // Release the slot if setup failed so a retry can succeed.
      this.activeLeaders.delete(teamId);
      throw err;
    }
  }

  async spawnTeammate(
    teamId: string,
    role: string,
    taskId: string,
    taskDescription: string,
    context?: string,
    cwd?: string,
  ): Promise<TeammateProcess> {
    const key = `${teamId}:${role}`;
    if (this.activeTeammates.has(key)) {
      throw new Error(`Teammate ${role} is already running for team ${teamId}`);
    }

    const team = await this.store.loadTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const task = await this.taskManager.getTask(teamId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Resolve the baseline working directory before worktree allocation.
    let effectiveCwd = cwd ?? task.worktree ?? team.repoRoots[0] ?? process.cwd();

    // -----------------------------------------------------------------------
    // Git worktree isolation
    // Write-capable teammates each get a dedicated git worktree so that
    // parallel execution on the same repository does not cause collisions.
    // Falls back to the shared cwd silently if git is unavailable.
    // -----------------------------------------------------------------------
    const repoRoot = team.repoRoots[0] ?? process.cwd();
    let allocatedWorktree: string | undefined;

    if (WRITE_CAPABLE_ROLES.has(role) && !task.worktree) {
      const worktreePath = path.join(os.tmpdir(), "pi-teams", teamId, role);
      const created = await createWorktree(repoRoot, worktreePath);
      if (created) {
        allocatedWorktree = created;
        effectiveCwd = created;
        // Record the worktree path on the task so it survives a restart.
        await this.taskManager.updateTask(teamId, taskId, { worktree: created });
      }
    }

    const prompt = this.buildTeammatePrompt(
      teamId,
      team.name,
      role,
      taskDescription,
      context,
      effectiveCwd,
    );
    const tempPrompt = await writePromptToTempFile(
      `teammate-${safeKebab(`${teamId}-${role}`)}`,
      prompt,
    );

    const controller = new AbortController();
    const proc = spawnPiJsonMode(tempPrompt.filePath, `Task: ${taskDescription}`, effectiveCwd);

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    const resultPromise = collectPiOutput(proc);
    const startedAt = new Date().toISOString();

    const processState: TeammateProcess = {
      role,
      teamId,
      taskId,
      state: "running",
      pid: proc.pid,
      cwd: effectiveCwd,
      startedAt,
    };
    await this.store.saveTeammateProcess(teamId, processState);
    await this.taskManager.updateTask(teamId, taskId, {
      status: "in_progress",
      owner: role,
      blockers: [],
    });
    await this.signalManager.emit(teamId, {
      source: role,
      type: "task_started",
      severity: "info",
      taskId,
      message: `Started ${task.title}`,
      links: [],
    });

    this.activeTeammates.set(key, { proc, abortController: controller });

    controller.signal.addEventListener(
      "abort",
      () => { try { proc.kill("SIGTERM"); } catch { /* ignore */ } },
      { once: true },
    );

    // Fire-and-forget: handle completion when the subprocess exits
    void resultPromise.then(async ({ output, exitCode: code }) => {
      this.activeTeammates.delete(key);
      try { await rm(tempPrompt.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      // Clean up git worktree if one was allocated for this teammate.
      if (allocatedWorktree) {
        await removeWorktree(repoRoot, allocatedWorktree);
      }

      const completedAt = new Date().toISOString();
      const wasCancelled = controller.signal.aborted;
      const latestTeam = await this.store.loadTeam(teamId);

      if (wasCancelled || latestTeam?.status === "cancelled") {
        await this.store.saveTeammateProcess(teamId, {
          ...processState, state: "cancelled", completedAt, output,
        });
        return;
      }

      if (code === 0) {
        await this.store.saveTeammateProcess(teamId, {
          ...processState, state: "completed", completedAt, output,
        });
        const outputFile = `${completedAt.replace(/[:.]/g, "-")}-${safeKebab(task.id)}.md`;
        if (output.trim()) {
          await this.store.saveTeammateOutput(teamId, role, outputFile, output);
        }
        await this.taskManager.updateTask(teamId, taskId, {
          status: "done",
          artifacts: output.trim()
            ? [...task.artifacts, `teammates/${role}/outputs/${outputFile}`]
            : task.artifacts,
        });
        await this.signalManager.emit(teamId, {
          source: role,
          type: "task_completed",
          severity: "info",
          taskId,
          message: output.split("\n")[0]?.trim() || `Completed ${task.title}`,
          links: output.trim() ? [`teammates/${role}/outputs/${outputFile}`] : [],
        });
        await this.automateTeammateHandoffs(
          teamId, role, task, output,
          output.trim() ? `teammates/${role}/outputs/${outputFile}` : undefined,
        );
        await this.taskManager.resolveDependencies(teamId);
      } else {
        const errorMessage = stderr.trim() || output || `Process exited with code ${code ?? 1}`;
        await this.store.saveTeammateProcess(teamId, {
          ...processState, state: "failed", completedAt, output, error: errorMessage,
        });
        await this.taskManager.updateTask(teamId, taskId, {
          status: "blocked",
          blockers: [errorMessage],
        });
        await this.signalManager.emit(teamId, {
          source: role,
          type: "error",
          severity: "error",
          taskId,
          message: `Failed ${task.title}: ${errorMessage}`,
          links: [],
        });
      }

      await this.runLeaderCycle(teamId);
    });

    return processState;
  }

  async stopTeam(teamId: string): Promise<void> {
    const leader = this.activeLeaders.get(teamId);
    if (leader) {
      clearInterval(leader.interval);
      leader.abortController.abort();
      this.activeLeaders.delete(teamId);
    }

    const roles = this.getActiveTeammates(teamId);
    for (const role of roles) {
      await this.stopTeammate(teamId, role);
    }

    const existing = await this.store.loadLeaderProcess(teamId);
    if (existing) {
      await this.store.saveLeaderProcess(teamId, {
        ...existing,
        state: "cancelled",
        completedAt: new Date().toISOString(),
      });
    }
  }

  async stopTeammate(teamId: string, role: string): Promise<void> {
    const key = `${teamId}:${role}`;
    const active = this.activeTeammates.get(key);
    if (active) {
      active.abortController.abort();
      this.activeTeammates.delete(key);
    }

    const current = await this.store.loadTeammateProcess(teamId, role);
    if (current) {
      await this.store.saveTeammateProcess(teamId, {
        ...current,
        state: "cancelled",
        completedAt: new Date().toISOString(),
      });
      if (current.taskId) {
        await this.taskManager.updateTask(teamId, current.taskId, {
          status: "blocked",
          blockers: [`${role} was stopped before completion`],
        });
      }
    }
  }

  isLeaderRunning(teamId: string): boolean {
    return this.activeLeaders.has(teamId);
  }

  isTeammateRunning(teamId: string, role: string): boolean {
    return this.activeTeammates.has(`${teamId}:${role}`);
  }

  getActiveTeammates(teamId: string): string[] {
    const prefix = `${teamId}:`;
    return [...this.activeTeammates.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async cleanup(): Promise<void> {
    for (const [teamId] of this.activeLeaders) {
      await this.stopTeam(teamId);
    }
    for (const [key, active] of this.activeTeammates) {
      active.abortController.abort();
      this.activeTeammates.delete(key);
    }
  }

  /**
   * Spawn a short-lived pi subprocess to analyze the objective and recommend
   * team composition. Falls back to the fullstack template roles if the
   * subprocess fails or returns unparseable output.
   */
  private async planTeamComposition(team: TeamRecord): Promise<string[]> {
    const FALLBACK_ROLES = TEAM_TEMPLATES.fullstack.roles as string[];
    const KNOWN_ROLES = new Set(Object.keys(TEAMMATE_ROLE_PROMPTS));
    const PLANNING_TIMEOUT_MS = 30_000;

    const prompt = [
      "You are a team composition planner for a software engineering team.",
      "",
      "## Objective",
      team.objective,
      "",
      "## Available Roles",
      "- researcher: Investigates codebase, gathers information, explores constraints",
      "- planner: Creates detailed implementation plans from findings",
      "- backend: Implements server-side code (APIs, services, database changes)",
      "- frontend: Implements user-facing code (components, pages, styles)",
      "- tester: Writes and runs tests (unit, integration, edge cases)",
      "- reviewer: Reviews code for correctness, security, and quality",
      "- docs: Writes and updates documentation",
      "",
      "## Rules",
      "- Select 2-4 roles that best match the objective",
      "- Always include 'reviewer' for quality assurance",
      "- Include 'researcher' if the objective involves unfamiliar code or investigation",
      "- Include 'tester' if the objective involves code changes",
      "",
      "Output ONLY a JSON array of role strings. No explanation, no markdown.",
      'Example: ["backend", "tester", "reviewer"]',
    ].join("\n");

    const tempPrompt = await writePromptToTempFile(`planner-${safeKebab(team.id)}`, prompt);

    try {
      const cwd = team.repoRoots[0] ?? process.cwd();
      const proc = spawnPiJsonMode(tempPrompt.filePath, `Select the right team roles for this objective: ${team.objective}`, cwd);

      const timeoutFallback = new Promise<PiProcessResult>((resolve) => {
        setTimeout(() => {
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          resolve({ output: "", exitCode: null });
        }, PLANNING_TIMEOUT_MS);
      });

      const { output } = await Promise.race([collectPiOutput(proc), timeoutFallback]);

      return this.parseRolesFromOutput(output, KNOWN_ROLES) ?? FALLBACK_ROLES;
    } catch {
      return FALLBACK_ROLES;
    } finally {
      try { await rm(tempPrompt.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** Extract a valid roles array from LLM output, or null if unparseable. */
  private parseRolesFromOutput(output: string, knownRoles: Set<string>): string[] | null {
    // Try parsing the entire output as JSON first (cleanest case)
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((r): r is string => typeof r === "string" && knownRoles.has(r));
        if (valid.length > 0) {
          if (!valid.includes("reviewer")) valid.push("reviewer");
          return valid;
        }
      }
    } catch { /* not pure JSON, try extracting */ }

    // Fallback: find the last [...] block (greedy — handles nested content)
    const matches = [...output.matchAll(/\[[^\]]*\]/g)];
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(matches[i][0]) as unknown;
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((r): r is string => typeof r === "string" && knownRoles.has(r));
          if (valid.length > 0) {
            if (!valid.includes("reviewer")) valid.push("reviewer");
            return valid;
          }
        }
      } catch { /* try next match */ }
    }

    return null;
  }

  private initialPhaseFor(team: TeamRecord): LeaderPhase {
    if (team.teammates.includes("researcher")) return "research";
    if (team.teammates.includes("planner")) return "synthesis";
    return "implementation";
  }

  private async ensureBootstrapTasks(teamId: string): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;
    const existing = await this.taskManager.getTasks(teamId);
    if (existing.length > 0) return;

    const researchOwner = team.teammates.find(
      (role) => role === "researcher" || role === "docs",
    );
    const plannerOwner =
      team.teammates.find((role) => role === "planner") ?? team.teammates[0];
    const implementationOwners = team.teammates.filter((role) =>
      ["backend", "frontend", "tester", "docs"].includes(role),
    );
    const reviewerOwner = team.teammates.find((role) => role === "reviewer");

    const created: TaskRecord[] = [];

    if (researchOwner) {
      const task = await this.taskManager.createTask(teamId, {
        title: `Research requirements for ${team.objective}`,
        description: `Investigate constraints, existing patterns, and relevant files for: ${team.objective}`,
        owner: researchOwner,
        status: "ready",
        priority: "high",
        dependsOn: [],
        riskLevel: "low",
        approvalRequired: false,
        artifacts: [],
        blockers: [],
      });
      created.push(task);
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "task_created",
        severity: "info",
        taskId: task.id,
        message: `Created research task for ${researchOwner}`,
        links: [],
      });
    }

    const synthesisDepends = created.map((task) => task.id);
    if (plannerOwner) {
      const task = await this.taskManager.createTask(teamId, {
        title: `Create implementation plan for ${team.objective}`,
        description: `Synthesize findings into a concrete implementation plan for: ${team.objective}`,
        owner: plannerOwner,
        status: synthesisDepends.length > 0 ? "todo" : "ready",
        priority: "high",
        dependsOn: synthesisDepends,
        riskLevel: "low",
        approvalRequired: false,
        artifacts: [],
        blockers: [],
      });
      created.push(task);
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "task_created",
        severity: "info",
        taskId: task.id,
        message: `Created synthesis task for ${plannerOwner}`,
        links: [],
      });
    }

    const planTask = created.find((task) =>
      task.title.startsWith("Create implementation plan"),
    );
    const implementationDepends = planTask
      ? [planTask.id]
      : created.map((task) => task.id);

    for (const role of implementationOwners) {
      const task = await this.taskManager.createTask(teamId, {
        title: `Implement ${roleDisplay(role)} work for ${team.objective}`,
        description: `Complete the ${role} slice of work for: ${team.objective}`,
        owner: role,
        status: implementationDepends.length > 0 ? "todo" : "ready",
        priority: "high",
        dependsOn: implementationDepends,
        riskLevel: role === "backend" || role === "frontend" ? "medium" : "low",
        approvalRequired: false,
        artifacts: [],
        blockers: [],
      });
      created.push(task);
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "task_created",
        severity: "info",
        taskId: task.id,
        message: `Created implementation task for ${role}`,
        links: [],
      });
    }

    if (reviewerOwner) {
      const dependsOn = created
        .filter((task) => task.owner !== reviewerOwner)
        .filter((task) => task.title.startsWith("Implement "))
        .map((task) => task.id);
      const task = await this.taskManager.createTask(teamId, {
        title: `Review completed work for ${team.objective}`,
        description: `Review the completed implementation for correctness, quality, and completeness.`,
        owner: reviewerOwner,
        status: dependsOn.length > 0 ? "todo" : "ready",
        priority: "medium",
        dependsOn,
        riskLevel: "low",
        approvalRequired: false,
        artifacts: [],
        blockers: [],
      });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "task_created",
        severity: "info",
        taskId: task.id,
        message: `Created verification task for ${reviewerOwner}`,
        links: [],
      });
    }
  }

  private async runLeaderCycle(teamId: string): Promise<void> {
    // Fix #4: skip if a cycle for this team is already in flight
    if (this.cycleRunning.has(teamId)) return;
    this.cycleRunning.add(teamId);
    try {
      await this._runLeaderCycleInner(teamId);
    } finally {
      this.cycleRunning.delete(teamId);
    }
  }

  private async _runLeaderCycleInner(teamId: string): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;
    if (
      team.status === "cancelled" ||
      team.status === "completed" ||
      team.status === "failed"
    ) {
      return;
    }

    // Process any new guidance messages sent to the leader by the user.
    await this.processLeaderMailbox(teamId);

    await this.taskManager.resolveDependencies(teamId);
    const tasks = await this.taskManager.getTasks(teamId);
    const phase = team.currentPhase ?? this.initialPhaseFor(team);
    const nextPhase = this.determinePhase(tasks, phase);
    if (nextPhase !== phase) {
      await this.teamManager.updateTeam(teamId, { currentPhase: nextPhase });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_summary",
        severity: "info",
        message: `Phase transition: ${phase} → ${nextPhase}`,
        links: [],
      });
    }

    const refreshedTasks = await this.taskManager.getTasks(teamId);
    if (
      refreshedTasks.length > 0 &&
      refreshedTasks.every(
        (task) => task.status === "done" || task.status === "cancelled",
      )
    ) {
      await this.teamManager.updateTeam(teamId, {
        status: "completed",
        currentPhase: "verification",
        summary: `All ${refreshedTasks.length} tasks completed`,
      });
      await this.store.saveLeaderProcess(teamId, {
        teamId,
        state: "completed",
        startedAt:
          (await this.store.loadLeaderProcess(teamId))?.startedAt ??
          new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_completed",
        severity: "info",
        message: `Team completed — ${team.objective}`,
        links: [],
      });

      const active = this.activeLeaders.get(teamId);
      if (active) {
        clearInterval(active.interval);
        this.activeLeaders.delete(teamId);
      }
      return;
    }

    const readyTasks = refreshedTasks
      .filter((task) => task.status === "ready")
      .sort((a, b) =>
        a.priority === b.priority
          ? a.createdAt.localeCompare(b.createdAt)
          : a.priority === "high"
            ? -1
            : b.priority === "high"
              ? 1
              : 0,
      );

    for (const task of readyTasks) {
      if (!task.owner) continue;
      if (this.isTeammateRunning(teamId, task.owner)) continue;

      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "task_assigned",
        severity: "info",
        taskId: task.id,
        message: `Assigned ${task.id} to ${task.owner}`,
        links: [],
      });

      const context = await this.buildTaskContext(teamId, task);
      try {
        await this.spawnTeammate(
          teamId,
          task.owner,
          task.id,
          buildTaskPrompt(task),
          context,
          task.worktree ?? team.repoRoots[0],
        );
      } catch (err) {
        await this.taskManager.updateTask(teamId, task.id, {
          status: "blocked",
          blockers: [err instanceof Error ? err.message : String(err)],
        });
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "error",
          severity: "error",
          taskId: task.id,
          message: `Failed to spawn ${task.owner}: ${err instanceof Error ? err.message : String(err)}`,
          links: [],
        });
      }
    }

    // Detect tasks that are stuck in in_progress but whose teammate process
    // is no longer running (e.g. after a session restart or unexpected exit).
    await this.detectStalledTasks(teamId);

    const summary = await this.teamManager.getTeamSummary(teamId);
    const summaryText =
      `${summary.progress.done}/${summary.progress.total} tasks done` +
      (summary.blockers.length > 0
        ? `, ${summary.blockers.length} blocker(s)`
        : "") +
      (summary.approvalsPending.length > 0
        ? `, ${summary.approvalsPending.length} approval(s) pending`
        : "");
    if (team.summary !== summaryText || team.status !== "running") {
      await this.teamManager.updateTeam(teamId, {
        status: "running",
        summary: summaryText,
      });
      await this.signalManager.emit(teamId, {
        source: "leader",
        type: "team_summary",
        severity: "info",
        message: `Summary — ${summary.progress.done}/${summary.progress.total} done, ${summary.blockers.length} blocker(s), ${summary.approvalsPending.length} approval(s) pending`,
        links: [],
      });
    }
  }

  private determinePhase(
    tasks: TaskRecord[],
    currentPhase: LeaderPhase,
  ): LeaderPhase {
    const hasResearch = tasks.some((task) =>
      task.title.startsWith("Research "),
    );
    const researchPending = tasks.some(
      (task) =>
        task.title.startsWith("Research ") &&
        task.status !== "done" &&
        task.status !== "cancelled",
    );
    const synthesisPending = tasks.some(
      (task) =>
        task.title.startsWith("Create implementation plan") &&
        task.status !== "done" &&
        task.status !== "cancelled",
    );
    const implementationPending = tasks.some(
      (task) =>
        task.title.startsWith("Implement ") &&
        task.status !== "done" &&
        task.status !== "cancelled",
    );
    const verificationPending = tasks.some(
      (task) =>
        task.title.startsWith("Review completed work") &&
        task.status !== "done" &&
        task.status !== "cancelled",
    );

    if (hasResearch && researchPending) return "research";
    if (synthesisPending) return "synthesis";
    if (implementationPending) return "implementation";
    if (verificationPending) return "verification";
    return currentPhase;
  }

  private async buildTaskContext(
    teamId: string,
    task: TaskRecord,
  ): Promise<string> {
    const [summary, signals, taskMailbox, directMailbox, team, discoveries, contracts, decisions] =
      await Promise.all([
        this.teamManager.getTeamSummary(teamId),
        this.signalManager.getSignals(teamId),
        this.mailboxManager.getMessages(teamId, { taskId: task.id }),
        task.owner
          ? this.mailboxManager.getMessagesFor(teamId, task.owner)
          : Promise.resolve([]),
        this.store.loadTeam(teamId),
        this.store.loadMemory(teamId, "discoveries"),
        this.store.loadMemory(teamId, "contracts"),
        this.store.loadMemory(teamId, "decisions"),
      ]);

    const recentSignals = signals
      .slice(-8)
      .map(
        (signal) => `- [${signal.type}] ${signal.source}: ${signal.message}`,
      );
    const mailbox = [
      ...new Map(
        [...directMailbox, ...taskMailbox].map((message) => [
          message.id,
          message,
        ]),
      ).values(),
    ]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-10);
    const messages = mailbox.map((message) => {
      const taskScope = message.taskId ? ` [${message.taskId}]` : "";
      return `- ${message.from} → ${message.to}${taskScope}: ${message.message}`;
    });

    const contextParts: string[] = [
      `Team: ${team?.name ?? teamId}`,
      `Objective: ${team?.objective ?? ""}`,
      `Phase: ${summary.currentPhase ?? "unknown"}`,
      `Progress: ${summary.progress.done}/${summary.progress.total}`,
      task.dependsOn.length > 0
        ? `Dependencies: ${task.dependsOn.join(", ")}`
        : "Dependencies: none",
      recentSignals.length > 0
        ? `Recent signals:\n${recentSignals.join("\n")}`
        : "Recent signals: none",
      messages.length > 0
        ? `Mailbox:\n${messages.join("\n")}`
        : "Mailbox: none",
    ];

    // Inject durable team memory so teammates build on prior knowledge.
    if (contracts) {
      contextParts.push(`Team Contracts (agreed interfaces):\n${contracts.slice(0, 2000)}`);
    }
    if (discoveries) {
      contextParts.push(`Team Discoveries:\n${discoveries.slice(0, 1500)}`);
    }
    if (decisions) {
      contextParts.push(`Team Decisions:\n${decisions.slice(0, 800)}`);
    }

    return contextParts.join("\n\n");
  }

  private buildLeaderPrompt(team: TeamRecord): string {
    return [
      `You are the LEADER of team \"${team.name}\".`,
      "",
      "## Your Role",
      "You orchestrate a team of specialists to accomplish an objective.",
      "You MUST delegate all implementation work to teammates.",
      "You MUST NOT execute code, edit files, or run commands directly.",
      "You can only read files for review and use orchestration data.",
      "",
      "## Objective",
      team.objective,
      "",
      "## Your Teammates",
      team.teammates.length > 0
        ? team.teammates.map((role) => `- ${role}`).join("\n")
        : "- none",
      "",
      "## Phases",
      "1. Research — understand objective, dependencies, and constraints.",
      "2. Synthesis — convert findings into tasks with dependencies.",
      "3. Implementation — assign ready work and monitor execution.",
      "4. Verification — review outputs, request revisions, finalize result.",
      "",
      "## Operating Loop",
      "1. Determine current phase",
      "2. Read tasks, signals, and mailbox",
      "3. Identify ready and blocked tasks",
      "4. Assign work or request revisions",
      "5. Review plan submissions and approvals",
      "6. Emit summary updates",
      "7. Evaluate phase transitions",
      "8. Continue until all tasks are done",
    ].join("\n");
  }

  private buildTeammatePrompt(
    teamId: string,
    teamName: string,
    role: string,
    taskDescription: string,
    context: string | undefined,
    cwd: string,
  ): string {
    return [
      `You are a ${role} on team "${teamName}".`,
      "",
      TEAMMATE_ROLE_PROMPTS[role] ??
        [
          `You are a ${role} specialist on a team.`,
          "Complete the assigned task carefully and report results clearly.",
        ].join("\n"),
      "",
      "## Your Task",
      taskDescription,
      "",
      "## Context",
      context?.trim() || "No additional context provided.",
      "",
      "## Working Directory",
      cwd,
      "",
      "## Team Memory",
      "You can record important knowledge to durable team memory using the `team_memory` tool.",
      "This knowledge persists after the team completes and is available to future teams.",
      `Use teamId: "${teamId}" and one of these types:`,
      '- "discoveries" — what you learned about the codebase (patterns, constraints, gotchas)',
      '- "decisions" — choices made and why (architectural decisions, tradeoffs)',
      '- "contracts" — agreed interfaces (API schemas, component props, shared types)',
      "",
      "## Output Format",
      "When your task is complete, provide a clear summary of:",
      "1. What was accomplished",
      "2. Files created or modified (with paths)",
      "3. Any issues or open questions",
      "4. Handoff notes for other teammates",
      "",
      "If another teammate needs context from your work, include a Handoffs section using this exact pattern:",
      "Handoffs:",
      "- to: frontend | message: API is ready at /settings/billing and returns { ... }",
      "- to: reviewer | message: Please focus on auth checks in billing-settings.ts",
      "",
      "These handoffs are automatically delivered to teammates through the team mailbox.",
    ].join("\n");
  }

  /**
   * Poll the leader's mailbox for new user guidance messages and surface them
   * as `team_summary` signals so they appear in the signal log and are visible
   * to teammates via `buildTaskContext()`.
   *
   * Uses an in-memory count cursor (`lastMailboxCount`) to process only new
   * messages per cycle. The cursor resets on leader restart, which is
   * acceptable — re-processing old guidance is harmless (just a dup signal).
   */
  private async processLeaderMailbox(teamId: string): Promise<void> {
    try {
      const allMessages = await this.mailboxManager.getMessagesFor(teamId, "leader");
      const lastCount = this.lastMailboxCount.get(teamId) ?? 0;

      if (allMessages.length <= lastCount) return;

      const newMessages = allMessages.slice(lastCount);
      this.lastMailboxCount.set(teamId, allMessages.length);

      for (const msg of newMessages) {
        if (msg.from === "user") {
          await this.signalManager.emit(teamId, {
            source: "leader",
            type: "team_summary",
            severity: "info",
            message: `User guidance received: ${msg.message.slice(0, 300)}`,
            links: [],
          });
          // Reflect the guidance in the team summary so it's visible in status queries.
          await this.teamManager.updateTeam(teamId, {
            summary: `User guidance: ${msg.message.slice(0, 200)}`,
          });
        }
      }
    } catch {
      // Mailbox polling is best-effort — never crash the leader cycle.
    }
  }

  /**
   * Detect tasks stuck in `in_progress` whose teammate process is no longer
   * running. This handles the case where a subprocess exits abnormally without
   * triggering the close handler (e.g. after a session restart, SIGKILL, or
   * unhandled process crash).
   *
   * Stalled tasks are moved to `blocked` with a clear reason, and a `blocked`
   * signal is emitted so the main session can react.
   */
  private async detectStalledTasks(teamId: string): Promise<void> {
    try {
      const tasks = await this.taskManager.getTasks(teamId);
      const inProgressTasks = tasks.filter(
        (t) => t.status === "in_progress" && t.owner,
      );

      for (const task of inProgressTasks) {
        if (!task.owner) continue;
        // If the teammate is still running, this task is fine.
        if (this.isTeammateRunning(teamId, task.owner)) continue;
        // Skip if already flagged as stalled (avoid duplicate signals).
        if (task.blockers.some((b) => b.includes("teammate process lost"))) continue;

        // Fix #2: only declare a task stalled after the grace period has elapsed.
        // This prevents false positives on the very cycle that spawned the subprocess.
        const age = Date.now() - Date.parse(task.updatedAt);
        if (age < STALL_GRACE_MS) continue;

        // Fix #3: circuit breaker — permanently cancel after MAX_TASK_RETRIES.
        const retryCount = (task.retryCount ?? 0) + 1;
        if (retryCount > MAX_TASK_RETRIES) {
          await this.taskManager.updateTask(teamId, task.id, {
            status: "cancelled",
            blockers: [
              ...task.blockers,
              `Max retries exceeded (${MAX_TASK_RETRIES}) — task could not complete`,
            ],
            retryCount,
          });
          await this.signalManager.emit(teamId, {
            source: "leader",
            type: "error",
            severity: "error",
            taskId: task.id,
            message: `Task ${task.id} permanently cancelled after ${MAX_TASK_RETRIES} failed retries — ${task.owner} process kept exiting`,
            links: [],
          });
          continue;
        }

        await this.taskManager.updateTask(teamId, task.id, {
          status: "blocked",
          blockers: [
            ...task.blockers,
            "teammate process lost — process exited without completing task",
          ],
          retryCount,
        });
        await this.signalManager.emit(teamId, {
          source: "leader",
          type: "blocked",
          severity: "warning",
          taskId: task.id,
          message: `Stalled task detected: ${task.id} (${task.title}) — ${task.owner} process lost (attempt ${retryCount}/${MAX_TASK_RETRIES})`,
          links: [],
        });
      }
    } catch {
      // Stall detection is best-effort — never crash the leader cycle.
    }
  }

  private async automateTeammateHandoffs(
    teamId: string,
    fromRole: string,
    completedTask: TaskRecord,
    output: string,
    outputArtifact?: string,
  ): Promise<void> {
    const team = await this.store.loadTeam(teamId);
    if (!team) return;

    const allTasks = await this.taskManager.getTasks(teamId);
    const downstreamTasks = allTasks.filter(
      (task) =>
        task.dependsOn.includes(completedTask.id) &&
        task.owner &&
        task.owner !== fromRole &&
        task.status !== "cancelled",
    );

    const explicitHandoffs = parseExplicitHandoffs(
      output,
      team.teammates,
      fromRole,
    );
    const explicitByRecipient = new Map(
      explicitHandoffs.map((handoff) => [handoff.to, handoff.message]),
    );
    const completionSummary = summarizeCompletionOutput(
      output,
      `Completed ${completedTask.title}.`,
    );

    const recipients = new Set<string>([
      ...downstreamTasks.map((task) => task.owner!).filter(Boolean),
      ...explicitHandoffs.map((handoff) => handoff.to),
    ]);

    for (const recipient of recipients) {
      if (!recipient || recipient === fromRole) continue;

      const recipientTask =
        downstreamTasks.find((task) => task.owner === recipient) ??
        allTasks.find(
          (task) =>
            task.owner === recipient &&
            task.status !== "done" &&
            task.status !== "cancelled",
        );

      const autoContext = recipientTask
        ? `${fromRole} completed dependency ${completedTask.id} (${completedTask.title}) for ${recipientTask.id}.`
        : `${fromRole} completed ${completedTask.id} (${completedTask.title}).`;
      const message =
        explicitByRecipient.get(recipient) ??
        `${autoContext} ${completionSummary}`;

      const mailboxMessage = await this.mailboxManager.send(teamId, {
        from: fromRole,
        to: recipient,
        taskId: recipientTask?.id,
        type: explicitByRecipient.has(recipient)
          ? "teammate_handoff"
          : "dependency_handoff",
        message,
        attachments: outputArtifact ? [outputArtifact] : [],
      });

      await this.signalManager.emit(teamId, {
        source: fromRole,
        type: "handoff",
        severity: "info",
        taskId: recipientTask?.id ?? completedTask.id,
        message: `Handoff sent to ${recipient}${recipientTask ? ` for ${recipientTask.id}` : ""}`,
        links: mailboxMessage.attachments,
      });
    }
  }
}
