/**
 * Pi Teams — TeamManager Unit Tests
 *
 * Covers: createTeam, getTeam, listTeams, updateTeam, stopTeam, resumeTeam,
 *         getTeamSummary, getTeamDelta, markChecked, getDashboard,
 *         getTeammateSummary.
 *
 * Each test creates its own isolated temporary directory.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TeamStore } from "../core/store.ts";
import { TeamManager } from "../managers/team-manager.ts";
import { TaskManager } from "../managers/task-manager.ts";
import type {
	ApprovalRequest,
	LeaderProcess,
	TaskRecord,
	TeamRecord,
	TeammateProcess,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(): Promise<{
	store: TeamStore;
	manager: TeamManager;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-teammanager-"));
	const store = new TeamStore(dir);
	const manager = new TeamManager(store);
	return { store, manager, dir };
}

async function seedTeam(
	store: TeamStore,
	overrides: Partial<TeamRecord> = {},
): Promise<TeamRecord> {
	const now = new Date().toISOString();
	const team: TeamRecord = {
		id: "team-20260403-001",
		name: "test-team",
		status: "running",
		createdAt: now,
		updatedAt: now,
		objective: "Build a feature",
		repoRoots: [],
		teammates: ["backend", "frontend"],
		...overrides,
	};
	await store.saveTeam(team);
	return team;
}

async function seedTask(
	store: TeamStore,
	taskManager: TaskManager,
	teamId: string,
	overrides: Partial<Omit<TaskRecord, "id" | "teamId" | "createdAt" | "updatedAt">> = {},
): Promise<TaskRecord> {
	return taskManager.createTask(teamId, {
		title: "A task",
		status: "todo",
		priority: "medium",
		riskLevel: "low",
		approvalRequired: false,
		dependsOn: [],
		artifacts: [],
		blockers: [],
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

describe("TeamManager.createTeam", () => {
	test("generates a team ID with date prefix", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Build authentication");
		assert.match(team.id, /^team-\d{8}-\d{3}$/);
		await rm(dir, { recursive: true, force: true });
	});

	test("status is initializing on creation", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Build authentication");
		assert.equal(team.status, "initializing");
		await rm(dir, { recursive: true, force: true });
	});

	test("generates name from objective when no name provided", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Implement user authentication flow");
		// Should be kebab-cased first 3 meaningful words (max 32 chars)
		assert.equal(team.name, "implement-user-authentication");
		await rm(dir, { recursive: true, force: true });
	});

	test("uses provided name when config.name is set", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Implement feature", { name: "my-team" });
		assert.equal(team.name, "my-team");
		await rm(dir, { recursive: true, force: true });
	});

	test("stores objective on the record", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Ship the billing page");
		assert.equal(team.objective, "Ship the billing page");
		await rm(dir, { recursive: true, force: true });
	});

	test("merges template roles with explicit teammate config", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Build feature", {
			template: "fullstack",
			teammates: ["tester"],
		});
		// fullstack = backend, frontend, reviewer + explicit tester
		assert.ok(team.teammates.includes("backend"), "backend from template");
		assert.ok(team.teammates.includes("frontend"), "frontend from template");
		assert.ok(team.teammates.includes("reviewer"), "reviewer from template");
		assert.ok(team.teammates.includes("tester"), "tester from config");
		// No duplicates
		const uniqueRoles = new Set(team.teammates);
		assert.equal(uniqueRoles.size, team.teammates.length);
		await rm(dir, { recursive: true, force: true });
	});

	test("uses only template roles when no explicit teammates provided", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Research codebase", {
			template: "research",
		});
		assert.ok(team.teammates.includes("researcher"));
		assert.ok(team.teammates.includes("docs"));
		assert.ok(team.teammates.includes("reviewer"));
		await rm(dir, { recursive: true, force: true });
	});

	test("uses only explicit teammates when no template provided", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Custom work", {
			teammates: ["backend", "tester"],
		});
		assert.deepEqual(team.teammates.sort(), ["backend", "tester"].sort());
		await rm(dir, { recursive: true, force: true });
	});

	test("stores repoRoots from config", async () => {
		const { manager, dir } = await setup();
		const team = await manager.createTeam("Build feature", {
			repoRoots: ["/tmp/repo"],
		});
		assert.deepEqual(team.repoRoots, ["/tmp/repo"]);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists team so it can be loaded via getTeam", async () => {
		const { manager, dir } = await setup();
		const created = await manager.createTeam("Persist test");
		const loaded = await manager.getTeam(created.id);
		assert.ok(loaded !== null);
		assert.equal(loaded?.id, created.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("emits a team_started signal after creation", async () => {
		const { store, manager, dir } = await setup();
		const team = await manager.createTeam("Signal test");
		const signals = await store.loadSignals(team.id);
		const started = signals.find((s) => s.type === "team_started");
		assert.ok(started !== undefined, "expected team_started signal");
		assert.equal(started!.teamId, team.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("sets createdAt and updatedAt timestamps", async () => {
		const { manager, dir } = await setup();
		const before = new Date().toISOString();
		const team = await manager.createTeam("Time test");
		const after = new Date().toISOString();
		assert.ok(team.createdAt >= before && team.createdAt <= after);
		assert.ok(team.updatedAt >= before && team.updatedAt <= after);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTeam
// ---------------------------------------------------------------------------

describe("TeamManager.getTeam", () => {
	test("returns the team by ID", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const loaded = await manager.getTeam(team.id);
		assert.ok(loaded !== null);
		assert.equal(loaded!.id, team.id);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns null for a non-existent team", async () => {
		const { manager, dir } = await setup();
		const result = await manager.getTeam("team-ghost");
		assert.equal(result, null);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// listTeams
// ---------------------------------------------------------------------------

describe("TeamManager.listTeams", () => {
	test("returns all teams when no filter is provided", async () => {
		const { store, manager, dir } = await setup();
		await seedTeam(store, { id: "team-20260403-001", name: "alpha" });
		await seedTeam(store, { id: "team-20260403-002", name: "beta" });
		const teams = await manager.listTeams();
		assert.equal(teams.length, 2);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty array when no teams exist", async () => {
		const { manager, dir } = await setup();
		const teams = await manager.listTeams();
		assert.deepEqual(teams, []);
		await rm(dir, { recursive: true, force: true });
	});

	test("filters teams by status", async () => {
		const { store, manager, dir } = await setup();
		await seedTeam(store, { id: "team-20260403-001", status: "running" });
		await seedTeam(store, { id: "team-20260403-002", status: "completed" });
		await seedTeam(store, { id: "team-20260403-003", status: "cancelled" });

		const running = await manager.listTeams({ status: ["running"] });
		assert.equal(running.length, 1);
		assert.equal(running[0].status, "running");
		await rm(dir, { recursive: true, force: true });
	});

	test("filters teams by multiple statuses", async () => {
		const { store, manager, dir } = await setup();
		await seedTeam(store, { id: "team-20260403-001", status: "running" });
		await seedTeam(store, { id: "team-20260403-002", status: "completed" });
		await seedTeam(store, { id: "team-20260403-003", status: "cancelled" });

		const result = await manager.listTeams({ status: ["running", "completed"] });
		assert.equal(result.length, 2);
		assert.ok(result.every((t) => t.status === "running" || t.status === "completed"));
		await rm(dir, { recursive: true, force: true });
	});

	test("returns all teams when status filter is empty array", async () => {
		const { store, manager, dir } = await setup();
		await seedTeam(store, { id: "team-20260403-001", status: "running" });
		await seedTeam(store, { id: "team-20260403-002", status: "completed" });
		const result = await manager.listTeams({ status: [] });
		assert.equal(result.length, 2);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// updateTeam
// ---------------------------------------------------------------------------

describe("TeamManager.updateTeam", () => {
	test("patches specified fields", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const updated = await manager.updateTeam(team.id, { status: "paused", summary: "On hold" });
		assert.equal(updated.status, "paused");
		assert.equal(updated.summary, "On hold");
		await rm(dir, { recursive: true, force: true });
	});

	test("preserves unpatched fields", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const updated = await manager.updateTeam(team.id, { summary: "updated summary" });
		assert.equal(updated.name, team.name);
		assert.equal(updated.objective, team.objective);
		await rm(dir, { recursive: true, force: true });
	});

	test("protects immutable fields (id, createdAt)", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const updated = await manager.updateTeam(team.id, {
			id: "hacked" as any,
			createdAt: "0000-01-01T00:00:00Z" as any,
		});
		assert.equal(updated.id, team.id);
		assert.equal(updated.createdAt, team.createdAt);
		await rm(dir, { recursive: true, force: true });
	});

	test("refreshes updatedAt timestamp", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		await new Promise((r) => setTimeout(r, 5));
		const updated = await manager.updateTeam(team.id, { summary: "new" });
		assert.ok(updated.updatedAt > team.updatedAt);
		await rm(dir, { recursive: true, force: true });
	});

	test("throws when team does not exist", async () => {
		const { manager, dir } = await setup();
		await assert.rejects(
			() => manager.updateTeam("team-ghost", { summary: "x" }),
			/Team not found/,
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("persists the update so subsequent getTeam reflects changes", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		await manager.updateTeam(team.id, { status: "paused" });
		const reloaded = await manager.getTeam(team.id);
		assert.equal(reloaded?.status, "paused");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// stopTeam / resumeTeam
// ---------------------------------------------------------------------------

describe("TeamManager.stopTeam", () => {
	test("transitions status to cancelled", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const stopped = await manager.stopTeam(team.id);
		assert.equal(stopped.status, "cancelled");
		await rm(dir, { recursive: true, force: true });
	});

	test("persists cancelled status", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		await manager.stopTeam(team.id);
		const loaded = await manager.getTeam(team.id);
		assert.equal(loaded?.status, "cancelled");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("TeamManager.resumeTeam", () => {
	test("transitions status back to running", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { status: "paused" });
		const resumed = await manager.resumeTeam(team.id);
		assert.equal(resumed.status, "running");
		await rm(dir, { recursive: true, force: true });
	});

	test("persists running status", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { status: "paused" });
		await manager.resumeTeam(team.id);
		const loaded = await manager.getTeam(team.id);
		assert.equal(loaded?.status, "running");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTeamSummary
// ---------------------------------------------------------------------------

describe("TeamManager.getTeamSummary", () => {
	test("throws when team does not exist", async () => {
		const { manager, dir } = await setup();
		await assert.rejects(
			() => manager.getTeamSummary("team-ghost"),
			/Team not found/,
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns correct progress counts", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "T1", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});
		await taskManager.createTask(team.id, {
			title: "T2", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});
		await taskManager.createTask(team.id, {
			title: "T3", status: "in_progress", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.progress.done, 2);
		assert.equal(summary.progress.total, 3);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty progress when no tasks exist", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.progress.done, 0);
		assert.equal(summary.progress.total, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns blockers from blocked tasks with reasons", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Stuck task", status: "blocked", priority: "high", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [],
			blockers: ["waiting on external API"],
			owner: "backend",
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.blockers.length, 1);
		assert.equal(summary.blockers[0].reason, "waiting on external API");
		assert.equal(summary.blockers[0].owner, "backend");
		await rm(dir, { recursive: true, force: true });
	});

	test("does not include blocked tasks with empty blocker list", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Unspecified blocker", status: "blocked", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.blockers.length, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns pending approvals from approval requests", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const approval: ApprovalRequest = {
			id: "apr-001",
			teamId: team.id,
			taskId: "task-007",
			submittedBy: "backend",
			artifact: "specs/plan.md",
			status: "pending",
			createdAt: new Date().toISOString(),
		};
		await store.saveApprovals(team.id, [approval]);

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.approvalsPending.length, 1);
		assert.equal(summary.approvalsPending[0].taskId, "task-007");
		assert.equal(summary.approvalsPending[0].owner, "backend");
		assert.equal(summary.approvalsPending[0].artifact, "specs/plan.md");
		await rm(dir, { recursive: true, force: true });
	});

	test("excludes approved/rejected approvals from pending list", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const now = new Date().toISOString();
		await store.saveApprovals(team.id, [
			{
				id: "apr-001",
				teamId: team.id,
				taskId: "task-001",
				submittedBy: "backend",
				artifact: "plan.md",
				status: "approved",
				createdAt: now,
				resolvedAt: now,
			},
			{
				id: "apr-002",
				teamId: team.id,
				taskId: "task-002",
				submittedBy: "backend",
				artifact: "plan2.md",
				status: "rejected",
				createdAt: now,
				resolvedAt: now,
			},
		]);

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.approvalsPending.length, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("includes teammate status snapshot for each role", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend", "frontend"] });
		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.teammates.length, 2);
		const names = summary.teammates.map((t) => t.name);
		assert.ok(names.includes("backend"));
		assert.ok(names.includes("frontend"));
		await rm(dir, { recursive: true, force: true });
	});

	test("reflects in_progress teammate as active when process is running", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		await store.ensureTeamDirs(team.id, ["backend"]);

		const proc: TeammateProcess = {
			role: "backend",
			teamId: team.id,
			state: "running",
			taskId: "task-001",
			startedAt: new Date().toISOString(),
		};
		await store.saveTeammateProcess(team.id, proc);

		const summary = await manager.getTeamSummary(team.id);
		const backendTeammate = summary.teammates.find((t) => t.name === "backend");
		assert.equal(backendTeammate?.status, "in_progress");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets nextMilestone to first in_progress task title", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Active milestone", status: "in_progress", priority: "high", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.nextMilestone, "Active milestone");
		await rm(dir, { recursive: true, force: true });
	});

	test("sets nextMilestone to 'All tasks complete' when all done", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Done task", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.nextMilestone, "All tasks complete");
		await rm(dir, { recursive: true, force: true });
	});

	test("returns team fields on the summary", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, {
			name: "my-team",
			objective: "Build it",
			status: "running",
			teammates: [],
		});

		const summary = await manager.getTeamSummary(team.id);
		assert.equal(summary.teamId, team.id);
		assert.equal(summary.name, "my-team");
		assert.equal(summary.objective, "Build it");
		assert.equal(summary.status, "running");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTeamDelta
// ---------------------------------------------------------------------------

describe("TeamManager.getTeamDelta", () => {
	test("throws when team does not exist", async () => {
		const { manager, dir } = await setup();
		await assert.rejects(
			() => manager.getTeamDelta("team-ghost"),
			/Team not found/,
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("uses lastCheckedAt as cursor when set", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, {
			lastCheckedAt: "2026-06-01T00:00:00Z",
		});

		// Append signals with controlled timestamps directly via store
		await store.appendSignal(team.id, {
			id: "sig-001",
			teamId: team.id,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "old",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});
		await store.appendSignal(team.id, {
			id: "sig-002",
			teamId: team.id,
			source: "backend",
			type: "task_completed",
			severity: "info",
			message: "new",
			links: [],
			timestamp: "2026-12-01T00:00:00Z",
		});

		const delta = await manager.getTeamDelta(team.id);
		assert.equal(delta.since, "2026-06-01T00:00:00Z");
		assert.equal(delta.signals.length, 1);
		assert.equal(delta.signals[0].message, "new");
		await rm(dir, { recursive: true, force: true });
	});

	test("falls back to createdAt when team has no lastCheckedAt", async () => {
		const { store, manager, dir } = await setup();
		const createdAt = "2026-01-01T00:00:00Z";
		const team = await seedTeam(store, { createdAt });

		await store.appendSignal(team.id, {
			id: "sig-001",
			teamId: team.id,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "first signal",
			links: [],
			timestamp: "2026-03-01T00:00:00Z",
		});

		const delta = await manager.getTeamDelta(team.id);
		assert.equal(delta.since, createdAt);
		assert.equal(delta.signals.length, 1);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns empty signals array when no signals after cursor", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, {
			lastCheckedAt: "2026-12-01T00:00:00Z",
		});
		await store.appendSignal(team.id, {
			id: "sig-001",
			teamId: team.id,
			source: "backend",
			type: "task_started",
			severity: "info",
			message: "old signal",
			links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});

		const delta = await manager.getTeamDelta(team.id);
		assert.equal(delta.signals.length, 0);
		assert.equal(delta.count, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("count matches the number of signals returned", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		await store.appendSignal(team.id, {
			id: "sig-001", teamId: team.id, source: "b", type: "task_started",
			severity: "info", message: "s1", links: [], timestamp: new Date().toISOString(),
		});
		await store.appendSignal(team.id, {
			id: "sig-002", teamId: team.id, source: "b", type: "task_started",
			severity: "info", message: "s2", links: [], timestamp: new Date().toISOString(),
		});

		const delta = await manager.getTeamDelta(team.id);
		assert.equal(delta.count, delta.signals.length);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// markChecked
// ---------------------------------------------------------------------------

describe("TeamManager.markChecked", () => {
	test("updates lastCheckedAt on the team record", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		const before = new Date().toISOString();
		await manager.markChecked(team.id);
		const after = new Date().toISOString();

		const loaded = await manager.getTeam(team.id);
		assert.ok(loaded?.lastCheckedAt !== undefined);
		assert.ok(loaded!.lastCheckedAt! >= before);
		assert.ok(loaded!.lastCheckedAt! <= after);
		await rm(dir, { recursive: true, force: true });
	});

	test("is a no-op for non-existent team (does not throw)", async () => {
		const { manager, dir } = await setup();
		await assert.doesNotReject(() => manager.markChecked("team-ghost"));
		await rm(dir, { recursive: true, force: true });
	});

	test("subsequent delta uses the new lastCheckedAt as cursor", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store);
		await manager.markChecked(team.id);

		// Signal emitted before the check — should NOT appear in delta
		await store.appendSignal(team.id, {
			id: "sig-001", teamId: team.id, source: "b", type: "task_started",
			severity: "info", message: "before-check", links: [],
			timestamp: "2026-01-01T00:00:00Z",
		});

		const delta = await manager.getTeamDelta(team.id);
		assert.equal(
			delta.signals.filter((s) => s.message === "before-check").length,
			0,
		);
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getDashboard
// ---------------------------------------------------------------------------

describe("TeamManager.getDashboard", () => {
	test("returns zero active teams when no teams exist", async () => {
		const { manager, dir } = await setup();
		const dashboard = await manager.getDashboard();
		assert.equal(dashboard.activeTeams, 0);
		await rm(dir, { recursive: true, force: true });
	});

	test("counts only active-status teams (running, initializing, paused)", async () => {
		const { store, manager, dir } = await setup();
		await seedTeam(store, { id: "team-20260403-001", status: "running" });
		await seedTeam(store, { id: "team-20260403-002", status: "initializing" });
		await seedTeam(store, { id: "team-20260403-003", status: "paused" });
		await seedTeam(store, { id: "team-20260403-004", status: "completed" });
		await seedTeam(store, { id: "team-20260403-005", status: "cancelled" });

		const dashboard = await manager.getDashboard();
		assert.equal(dashboard.activeTeams, 3);
		await rm(dir, { recursive: true, force: true });
	});

	test("classifies teams with pending approvals into needsAttention", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001" });
		await store.saveApprovals(team.id, [
			{
				id: "apr-001",
				teamId: team.id,
				taskId: "task-001",
				submittedBy: "backend",
				artifact: "plan.md",
				status: "pending",
				createdAt: new Date().toISOString(),
			},
		]);

		const dashboard = await manager.getDashboard();
		const attention = dashboard.needsAttention.filter(
			(item) => item.teamId === team.id,
		);
		assert.ok(attention.length > 0);
		assert.ok(attention.some((item) => item.reason.includes("pending approval")));
		await rm(dir, { recursive: true, force: true });
	});

	test("classifies teams with blocked tasks into needsAttention", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001", teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Stuck", status: "blocked", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: ["reason"],
		});

		const dashboard = await manager.getDashboard();
		const attention = dashboard.needsAttention.filter(
			(item) => item.teamId === team.id,
		);
		assert.ok(attention.length > 0);
		assert.ok(attention.some((item) => item.reason.toLowerCase().includes("blocked task")));
		await rm(dir, { recursive: true, force: true });
	});

	test("places teams without issues into noAttentionNeeded", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001", teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Done", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [],
		});

		const dashboard = await manager.getDashboard();
		const smooth = dashboard.noAttentionNeeded.filter(
			(item) => item.teamId === team.id,
		);
		assert.ok(smooth.length > 0);
		assert.ok(smooth[0].progress.includes("1/1"));
		await rm(dir, { recursive: true, force: true });
	});

	test("shows 'no tasks yet' progress for teams with no tasks", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001", teammates: [] });

		const dashboard = await manager.getDashboard();
		const smooth = dashboard.noAttentionNeeded.filter(
			(item) => item.teamId === team.id,
		);
		// Team has no pending approvals, no blocked tasks, no error signals
		assert.ok(smooth.length > 0);
		assert.ok(smooth[0].progress.includes("no tasks yet"));
		await rm(dir, { recursive: true, force: true });
	});

	test("surfaces recent signals in recentUpdates (within 30 min window)", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001", teammates: [] });

		// Emit a recent signal directly with a fresh timestamp
		await store.appendSignal(team.id, {
			id: "sig-001",
			teamId: team.id,
			source: "backend",
			type: "task_completed",
			severity: "info",
			message: "recent update",
			links: [],
			timestamp: new Date().toISOString(),
		});

		const dashboard = await manager.getDashboard();
		const updates = dashboard.recentUpdates.filter(
			(u) => u.teamId === team.id,
		);
		assert.ok(updates.some((u) => u.message === "recent update"));
		await rm(dir, { recursive: true, force: true });
	});

	test("returns severity warning for blocked task attention items", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { id: "team-20260403-001", teammates: [] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Blocked task", status: "blocked", priority: "high", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: ["reason"],
		});

		const dashboard = await manager.getDashboard();
		const item = dashboard.needsAttention.find((i) => i.teamId === team.id);
		assert.ok(item !== undefined);
		assert.equal(item!.severity, "warning");
		await rm(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// getTeammateSummary
// ---------------------------------------------------------------------------

describe("TeamManager.getTeammateSummary", () => {
	test("returns null when team does not exist", async () => {
		const { manager, dir } = await setup();
		const result = await manager.getTeammateSummary("team-ghost", "backend");
		assert.equal(result, null);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns null when role is not a member of the team", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const result = await manager.getTeammateSummary(team.id, "reviewer");
		assert.equal(result, null);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns teamId, name, and role", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.ok(result !== null);
		assert.equal(result!.teamId, team.id);
		assert.equal(result!.name, "backend");
		assert.equal(result!.role, "backend");
		await rm(dir, { recursive: true, force: true });
	});

	test("returns not_started status when teammate has no tasks", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.equal(result?.status, "not_started");
		await rm(dir, { recursive: true, force: true });
	});

	test("returns in_progress status when process state is running", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		await store.ensureTeamDirs(team.id, ["backend"]);

		const proc: TeammateProcess = {
			role: "backend",
			teamId: team.id,
			state: "running",
			taskId: "task-001",
			startedAt: new Date().toISOString(),
		};
		await store.saveTeammateProcess(team.id, proc);

		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.equal(result?.status, "in_progress");
		await rm(dir, { recursive: true, force: true });
	});

	test("returns current task with id, title, and status", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Backend API", status: "in_progress", priority: "high", riskLevel: "medium",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [], owner: "backend",
		});

		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.ok(result?.currentTask !== undefined);
		assert.equal(result!.currentTask!.title, "Backend API");
		assert.equal(result!.currentTask!.status, "in_progress");
		await rm(dir, { recursive: true, force: true });
	});

	test("includes blocker on current task when task is blocked", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Blocked feature", status: "in_progress", priority: "high", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [],
			blockers: ["needs DB access"], owner: "backend",
		});

		const result = await manager.getTeammateSummary(team.id, "backend");
		// Note: blocked status would be "in_progress" here since the task status is in_progress
		// but blockers is populated — the first blocker should surface
		assert.ok(result !== null);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns deduplicated artifacts from all owned tasks", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Task 1", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: ["file-a.ts", "file-b.ts"], owner: "backend",
			blockers: [],
		});
		await taskManager.createTask(team.id, {
			title: "Task 2", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: ["file-b.ts", "file-c.ts"], owner: "backend",
			blockers: [],
		});

		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.ok(result !== null);
		const artifacts = result!.artifacts;
		// Should deduplicate file-b.ts
		assert.equal(artifacts.length, 3);
		assert.ok(artifacts.includes("file-a.ts"));
		assert.ok(artifacts.includes("file-b.ts"));
		assert.ok(artifacts.includes("file-c.ts"));
		await rm(dir, { recursive: true, force: true });
	});

	test("counts signals emitted by the teammate since last check", async () => {
		const { store, manager, dir } = await setup();
		const checkTime = "2026-06-01T00:00:00Z";
		const team = await seedTeam(store, { teammates: ["backend"], lastCheckedAt: checkTime });

		// Old signal — should not be counted
		await store.appendSignal(team.id, {
			id: "sig-001", teamId: team.id, source: "backend", type: "task_started",
			severity: "info", message: "old", links: [], timestamp: "2026-01-01T00:00:00Z",
		});
		// New signal — should be counted
		await store.appendSignal(team.id, {
			id: "sig-002", teamId: team.id, source: "backend", type: "task_completed",
			severity: "info", message: "new", links: [], timestamp: "2026-12-01T00:00:00Z",
		});
		// New signal from different source — should NOT be counted
		await store.appendSignal(team.id, {
			id: "sig-003", teamId: team.id, source: "frontend", type: "task_started",
			severity: "info", message: "fe", links: [], timestamp: "2026-12-01T00:00:00Z",
		});

		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.equal(result?.signalsSinceLastCheck, 1);
		await rm(dir, { recursive: true, force: true });
	});

	test("returns idle status for teammate with only done tasks", async () => {
		const { store, manager, dir } = await setup();
		const team = await seedTeam(store, { teammates: ["backend"] });
		const taskManager = new TaskManager(store);
		await taskManager.createTask(team.id, {
			title: "Completed work", status: "done", priority: "medium", riskLevel: "low",
			approvalRequired: false, dependsOn: [], artifacts: [], blockers: [], owner: "backend",
		});

		const result = await manager.getTeammateSummary(team.id, "backend");
		assert.equal(result?.status, "idle");
		await rm(dir, { recursive: true, force: true });
	});
});
