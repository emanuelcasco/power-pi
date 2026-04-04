/**
 * Pi Teams — TeamManager
 *
 * High-level operations on team records. Reads from and writes to the
 * persistence layer (`TeamStore`) and never touches the filesystem directly.
 *
 * Responsibilities:
 *  - CRUD for `TeamRecord`
 *  - Aggregated summary and delta views
 *  - Multi-team dashboard
 *  - Per-teammate snapshot
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
	DeltaResponse,
	MultiTeamDashboard,
	Signal,
	TaskStatus,
	TeamConfig,
	TeamRecord,
	TeamStatus,
	TeamSummary,
	TeammateSummary,
} from "../core/types.js";
import { TEAM_TEMPLATES } from "../core/types.js";
import { type TeamStore, generateId } from "../core/store.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Common words that carry no naming value. */
const STOP_WORDS = new Set([
	"a", "an", "the", "and", "or", "for", "in", "of", "to",
	"with", "from", "by", "at", "on", "is", "it", "as",
	"be", "do", "has", "had", "this", "that", "read", "file",
]);

/**
 * Convert a free-form objective string into a short, kebab-cased name.
 *
 * Rules:
 * - Replace every non-alphanumeric char with a space (so paths split into tokens)
 * - Drop tokens that are pure noise (stopwords, length < 3, or length > 16)
 * - Keep the first 3 meaningful tokens, joined with "-"
 * - Hard cap at 32 characters
 *
 * @example objectiveToName("Implement user authentication flow") → "implement-user-authentication"
 * @example objectiveToName("refactor READ '/path/to/file.md'")  → "refactor-path-implement"
 */
function objectiveToName(objective: string): string {
	const tokens = objective
		.toLowerCase()
		.replace(/[^a-z0-9]/g, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length >= 3 && w.length <= 16 && !STOP_WORDS.has(w));

	return (tokens.slice(0, 3).join("-") || "team").slice(0, 32);
}

// ---------------------------------------------------------------------------
// TeamManager
// ---------------------------------------------------------------------------

export class TeamManager {
	constructor(private store: TeamStore) {}

	// -------------------------------------------------------------------------
	// Core CRUD
	// -------------------------------------------------------------------------

	/**
	 * Create a new team record, set up the directory tree, and emit a
	 * `team_started` signal.
	 *
	 * **Does not** launch the leader agent — that is the caller's responsibility.
	 */
	async createTeam(objective: string, config?: TeamConfig): Promise<TeamRecord> {
		const id = generateId("team");

		// Resolve teammate list: merge template roles (if any) with explicit config roles.
		let teammates = config?.teammates ?? [];
		if (config?.template) {
			const template = TEAM_TEMPLATES[config.template];
			if (template) {
				teammates = [...new Set([...template.roles, ...teammates])];
			}
		}

		const name = config?.name ?? objectiveToName(objective);
		const now = new Date().toISOString();

		const team: TeamRecord = {
			id,
			name,
			status: "initializing",
			createdAt: now,
			updatedAt: now,
			objective,
			repoRoots: config?.repoRoots ?? [],
			teammates,
		};

		// Create directory tree before persisting so the record is always backed
		// by a valid directory structure.
		await this.store.ensureTeamDirs(id, teammates);
		await this.store.saveTeam(team);

		// Emit team_started signal so the history is complete from day zero.
		const signal: Signal = {
			id: generateId("sig"),
			teamId: id,
			source: "system",
			type: "team_started",
			severity: "info",
			timestamp: now,
			message: `Team "${name}" created. Objective: ${objective}`,
			links: [],
		};
		await this.store.appendSignal(id, signal);

		return team;
	}

	/** Load a team record by ID. Returns `null` when the team does not exist. */
	async getTeam(teamId: string): Promise<TeamRecord | null> {
		return this.store.loadTeam(teamId);
	}

	/**
	 * List all persisted teams, optionally filtered by status.
	 *
	 * @param filter.status  Restrict results to teams whose status is in this list.
	 */
	async listTeams(filter?: { status?: TeamStatus[] }): Promise<TeamRecord[]> {
		const teams = await this.store.listTeams();
		if (!filter?.status?.length) return teams;
		return teams.filter((t) => filter.status!.includes(t.status));
	}

	/**
	 * Apply a partial update to a team record.
	 *
	 * Immutable fields (`id`, `createdAt`) are always preserved.
	 * `updatedAt` is refreshed automatically.
	 */
	async updateTeam(teamId: string, patch: Partial<TeamRecord>): Promise<TeamRecord> {
		const team = await this.store.loadTeam(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const updated: TeamRecord = {
			...team,
			...patch,
			// Protect immutable fields
			id: team.id,
			createdAt: team.createdAt,
			updatedAt: new Date().toISOString(),
		};

		await this.store.saveTeam(updated);
		return updated;
	}

	/** Transition a running team to the `cancelled` status. */
	async stopTeam(teamId: string): Promise<TeamRecord> {
		return this.updateTeam(teamId, { status: "cancelled" });
	}

	/** Transition a paused team back to the `running` status. */
	async resumeTeam(teamId: string): Promise<TeamRecord> {
		return this.updateTeam(teamId, { status: "running" });
	}

	// -------------------------------------------------------------------------
	// Aggregated views
	// -------------------------------------------------------------------------

	/**
	 * Build a compact summary for a team by aggregating data from
	 * `team.json`, `tasks.json`, `signals.ndjson`, and `approvals.json`.
	 */
	async getTeamSummary(teamId: string): Promise<TeamSummary> {
		const [team, tasks, approvals, teammateProcesses] = await Promise.all([
			this.store.loadTeam(teamId),
			this.store.loadTasks(teamId),
			this.store.loadApprovals(teamId),
			this.store.loadAllTeammateProcesses(teamId),
		]);

		if (!team) throw new Error(`Team not found: ${teamId}`);

		// --- Progress ---
		const done = tasks.filter((t) => t.status === "done").length;
		const total = tasks.length;

		// --- Blockers ---
		const blockers = tasks
			.filter((t) => t.status === "blocked" && t.blockers.length > 0)
			.flatMap((t) =>
				t.blockers.map((reason) => ({
					taskId: t.id,
					owner: t.owner ?? "unassigned",
					reason,
				})),
			);

		// --- Pending approvals ---
		const approvalsPending = approvals
			.filter((a) => a.status === "pending")
			.map((a) => ({
				taskId: a.taskId,
				owner: a.submittedBy,
				artifact: a.artifact,
			}));

		// --- Per-teammate status snapshot ---
		const teammates = team.teammates.map((role) => {
			const process = teammateProcesses.find((item) => item.role === role);
			const activeTask = tasks.find(
				(t) =>
					t.owner === role &&
					(t.status === "in_progress" ||
						t.status === "planning" ||
						t.status === "awaiting_approval" ||
						t.status === "in_review"),
			);
			const anyTask = tasks.find(
				(t) => t.owner === role && t.status !== "cancelled",
			);

			return {
				name: role,
				status: process?.state === "running" ? "in_progress" : activeTask?.status ?? (anyTask ? "idle" : "not_started"),
				currentTask: activeTask?.title ?? tasks.find((t) => t.id === process?.taskId)?.title,
				summary: process?.state === "running"
					? `Running ${tasks.find((t) => t.id === process.taskId)?.title ?? "assigned task"}`
					: activeTask
					? `Working on: ${activeTask.title}`
					: anyTask
						? `Last: ${anyTask.title}`
						: "No tasks yet",
			};
		});

		// --- Next milestone ---
		// Prefer the first in-progress task; fall back to ready, then todo.
		const milestonePriority = [
			"in_progress",
			"ready",
			"todo",
		] as const;

		let nextMilestone: string | undefined;
		for (const s of milestonePriority) {
			const match = tasks.find((t) => t.status === s);
			if (match) {
				nextMilestone = match.title;
				break;
			}
		}
		if (!nextMilestone && done > 0 && done === total) {
			nextMilestone = "All tasks complete";
		}

		return {
			teamId,
			name: team.name,
			status: team.status,
			objective: team.objective,
			currentPhase: team.currentPhase,
			progress: { done, total },
			teammates,
			blockers,
			approvalsPending,
			nextMilestone,
			lastCheckedAt: team.lastCheckedAt,
			updatedAt: team.updatedAt,
		};
	}

	/**
	 * Return all signals emitted since the user's last check-in.
	 *
	 * The cursor is `team.lastCheckedAt`; if the team has never been checked,
	 * the cursor falls back to `team.createdAt` (i.e. the full signal history).
	 */
	async getTeamDelta(teamId: string): Promise<DeltaResponse> {
		const team = await this.store.loadTeam(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const since = team.lastCheckedAt ?? team.createdAt;
		const signals = await this.store.loadSignalsSince(teamId, since);

		return {
			teamId,
			since,
			signals,
			count: signals.length,
		};
	}

	/** Stamp the current time as the user's last inspection of this team. */
	async markChecked(teamId: string): Promise<void> {
		await this.store.setLastChecked(teamId, new Date().toISOString());
	}

	// -------------------------------------------------------------------------
	// Multi-team dashboard
	// -------------------------------------------------------------------------

	/**
	 * Aggregate a cross-team dashboard by iterating every persisted team and
	 * categorising it into:
	 *
	 * - `needsAttention`   — pending approvals, blocked tasks, or error signals
	 * - `recentUpdates`    — signals emitted in the past 30 minutes
	 * - `noAttentionNeeded` — teams progressing without issues
	 */
	async getDashboard(): Promise<MultiTeamDashboard> {
		const allTeams = await this.store.listTeams();

		const activeStatuses: TeamStatus[] = ["running", "initializing", "paused"];
		const activeCount = allTeams.filter((t) =>
			activeStatuses.includes(t.status),
		).length;

		const needsAttention: MultiTeamDashboard["needsAttention"] = [];
		const recentUpdates: MultiTeamDashboard["recentUpdates"] = [];
		const noAttentionNeeded: MultiTeamDashboard["noAttentionNeeded"] = [];

		// Rolling window for "recent" signals
		const recentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

		for (const team of allTeams) {
			const [tasks, approvals, recentSignals] = await Promise.all([
				this.store.loadTasks(team.id),
				this.store.loadApprovals(team.id),
				this.store.loadSignalsSince(team.id, recentCutoff),
			]);

			const pendingApprovals = approvals.filter((a) => a.status === "pending");
			const blockedTasks = tasks.filter((t) => t.status === "blocked");
			const errorSignals = recentSignals.filter((s) => s.severity === "error");

			let attentionNeeded = false;

			if (pendingApprovals.length > 0) {
				needsAttention.push({
					teamId: team.id,
					reason: `${pendingApprovals.length} pending approval(s)`,
					severity: "warning",
				});
				attentionNeeded = true;
			}

			if (blockedTasks.length > 0) {
				needsAttention.push({
					teamId: team.id,
					reason: `${blockedTasks.length} blocked task(s): ${blockedTasks.map((t) => t.title).join(", ")}`,
					severity: "warning",
				});
				attentionNeeded = true;
			}

			if (errorSignals.length > 0) {
				needsAttention.push({
					teamId: team.id,
					reason: `Error: ${errorSignals[0].message}`,
					severity: "error",
				});
				attentionNeeded = true;
			}

			// Surface up to 3 recent signals per team
			for (const signal of recentSignals.slice(-3)) {
				recentUpdates.push({
					teamId: team.id,
					type: signal.type,
					message: signal.message,
				});
			}

			if (!attentionNeeded) {
				const doneTasks = tasks.filter((t) => t.status === "done").length;
				const progressStr =
					tasks.length > 0
						? `${doneTasks}/${tasks.length} tasks done`
						: "no tasks yet";

				noAttentionNeeded.push({
					teamId: team.id,
					progress: progressStr,
					status: team.status,
				});
			}
		}

		return {
			activeTeams: activeCount,
			needsAttention,
			recentUpdates,
			noAttentionNeeded,
		};
	}

	// -------------------------------------------------------------------------
	// Teammate snapshot
	// -------------------------------------------------------------------------

	/**
	 * Return a detailed snapshot of a single teammate within a team.
	 *
	 * Returns `null` when the team does not exist or the role is not a member.
	 */
	async getTeammateSummary(
		teamId: string,
		role: string,
	): Promise<TeammateSummary | null> {
		const team = await this.store.loadTeam(teamId);
		if (!team || !team.teammates.includes(role)) return null;

		const tasks = await this.store.loadTasks(teamId);
		const process = await this.store.loadTeammateProcess(teamId, role);
		const roleTasks = tasks.filter((t) => t.owner === role);

		// Current task: the first actively-progressing task for this role
		const currentTask = roleTasks.find((t) =>
			["in_progress", "planning", "awaiting_approval", "in_review"].includes(
				t.status,
			),
		);

		// Signals since last user check
		const since = team.lastCheckedAt ?? team.createdAt;
		const recentSignals = await this.store.loadSignalsSince(teamId, since);
		const roleSignalCount = recentSignals.filter(
			(s) => s.source === role,
		).length;

		// Deduplicated artifact list from all tasks owned by this role
		const artifacts = [...new Set(roleTasks.flatMap((t) => t.artifacts))];

		// Attempt to read the most-recently written file from the outputs dir
		let lastOutput: string | undefined;
		const outputsDir = join(
			this.store.getTeammateDir(teamId, role),
			"outputs",
		);
		try {
			const files = await readdir(outputsDir);
			if (files.length > 0) {
				const latest = files.sort().at(-1)!;
				lastOutput = await readFile(join(outputsDir, latest), "utf8");
			}
		} catch {
			// Outputs directory may not exist yet — that's expected early on
		}

		const currentTaskSummary = currentTask
			? {
					id: currentTask.id,
					title: currentTask.title,
					status: currentTask.status,
					blocker: currentTask.blockers[0],
				}
			: process?.taskId
				? (() => {
						const task = tasks.find((item) => item.id === process.taskId);
						return task
							? {
									id: task.id,
									title: task.title,
									status: task.status,
									blocker: task.blockers[0],
								}
							: undefined;
					})()
				: undefined;

		const status =
			(process?.state === "running" ? "in_progress" : currentTask?.status) ??
			(roleTasks.length > 0 ? "idle" : "not_started");

		return {
			teamId,
			name: role,
			role,
			status,
			currentTask: currentTaskSummary,
			lastOutput: process?.output ?? lastOutput,
			worktree: process?.cwd,
			artifacts,
			signalsSinceLastCheck: roleSignalCount,
			updatedAt: new Date().toISOString(),
		};
	}
}
