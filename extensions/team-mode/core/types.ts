/**
 * Pi Teams — Type Definitions
 *
 * Single source of truth for all team-mode types and constants.
 * All other modules in this extension should import from here.
 */

// ---------------------------------------------------------------------------
// Primitive enumerations
// ---------------------------------------------------------------------------

/** Lifecycle state of a team run. */
export type TeamStatus =
	| "initializing"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

/** Lifecycle state of an individual task within a team. */
export type TaskStatus =
	| "todo"
	| "ready"
	| "planning"
	| "awaiting_approval"
	| "in_progress"
	| "blocked"
	| "in_review"
	| "done"
	| "cancelled";

/** Structured event type emitted by leaders and teammates. */
export type SignalType =
	| "team_started"
	| "task_created"
	| "task_assigned"
	| "task_started"
	| "progress_update"
	| "handoff"
	| "blocked"
	| "plan_submitted"
	| "approval_requested"
	| "approval_granted"
	| "approval_rejected"
	| "task_completed"
	| "team_summary"
	| "team_completed"
	| "error";

/** Importance level of a signal. */
export type SignalSeverity = "info" | "warning" | "error";

/** Risk level used to determine whether a task requires approval. */
export type RiskLevel = "low" | "medium" | "high";

/** Phase the leader is currently operating in. */
export type LeaderPhase = "research" | "synthesis" | "implementation" | "verification";

/**
 * The role identifier for a teammate.
 * Built-in roles are listed explicitly; custom roles are allowed via `string`.
 */
export type TeammateRole =
	| "researcher"
	| "planner"
	| "backend"
	| "frontend"
	| "reviewer"
	| "tester"
	| "docs"
	| string;

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

/** Persisted metadata for a team run. Stored in `team.json`. */
export interface TeamRecord {
	/** Unique identifier, e.g. `team-20260403-001`. */
	id: string;
	/** Human-readable name derived from objective or config. */
	name: string;
	/** Current lifecycle state. */
	status: TeamStatus;
	/** ISO 8601 timestamp — when the team was created. */
	createdAt: string;
	/** ISO 8601 timestamp — last mutation to this record. */
	updatedAt: string;
	/** Pi session id for the leader agent, if it has been launched. */
	leaderSessionId?: string;
	/** The original goal given by the user. */
	objective: string;
	/** Repo root paths accessible to this team. */
	repoRoots: string[];
	/** List of teammate role names on this team. */
	teammates: string[];
	/** Short narrative summary produced by the leader. */
	summary?: string;
	/** Current leader phase. */
	currentPhase?: LeaderPhase;
	/** ISO 8601 timestamp — last time the user inspected this team. */
	lastCheckedAt?: string;
}

/** Persisted representation of a unit of work. Stored in `tasks.json`. */
export interface TaskRecord {
	/** Unique identifier, e.g. `task-001`. */
	id: string;
	/** The team this task belongs to. */
	teamId: string;
	/** Short title describing the work. */
	title: string;
	/** Optional extended description. */
	description?: string;
	/** Teammate role responsible for this task. */
	owner?: string;
	/** Current lifecycle state. */
	status: TaskStatus;
	/** Scheduling priority. */
	priority: "low" | "medium" | "high";
	/** IDs of tasks that must be `done` before this one can become `ready`. */
	dependsOn: string[];
	/** Risk level — determines whether approval is required. */
	riskLevel: RiskLevel;
	/** Whether the task must go through an approval gate before execution. */
	approvalRequired: boolean;
	/** Git branch used by the owner for this task, if any. */
	branch?: string;
	/** Filesystem path of the worktree allocated for this task, if any. */
	worktree?: string;
	/** Paths to files or documents produced as output. */
	artifacts: string[];
	/** Human-readable reasons why the task is currently blocked. */
	blockers: string[];
	/** ISO 8601 timestamp — when this task was created. */
	createdAt: string;
	/** ISO 8601 timestamp — last mutation to this record. */
	updatedAt: string;
	/** Number of times this task has been retried after a stall or failure. */
	retryCount?: number;
}

/** An append-only event in the team signal log. Stored in `signals.ndjson`. */
export interface Signal {
	/** Unique identifier, e.g. `sig-001`. */
	id: string;
	/** The team this signal belongs to. */
	teamId: string;
	/** Role or identity of the agent that emitted the signal, or `'leader'`. */
	source: string;
	/** Structured event type. */
	type: SignalType;
	/** Importance level. */
	severity: SignalSeverity;
	/** Task this signal is associated with, if any. */
	taskId?: string;
	/** ISO 8601 timestamp — when this signal was emitted. */
	timestamp: string;
	/** Human-readable description of the event. */
	message: string;
	/** Related artifact paths or URIs. */
	links: string[];
	/**
	 * When `true`, this signal was emitted by a teammate subprocess rather than
	 * the leader or system. Sidechain signals can be filtered out when replaying
	 * the main conversation transcript without losing orchestration-level context.
	 *
	 * Inspired by Claurst's `is_sidechain` flag in `session_storage.rs`.
	 */
	isSidechain?: boolean;
}

/** A structured message in the team mailbox. Stored in `mailbox.ndjson`. */
export interface MailboxMessage {
	/** Unique identifier, e.g. `msg-001`. */
	id: string;
	/** The team this message belongs to. */
	teamId: string;
	/** Role or identity of the sender. */
	from: string;
	/** Role name, `'all'` (broadcast), or `'leader'`. */
	to: string;
	/** Task this message is scoped to, if any. */
	taskId?: string;
	/** Semantic type of the message, e.g. `'contract_handoff'`. */
	type: string;
	/** Human-readable body. */
	message: string;
	/** Paths to attached artifacts. */
	attachments: string[];
	/** ISO 8601 timestamp — when this message was created. */
	createdAt: string;
}

/** An approval request for a risky task plan. Stored in `approvals.json`. */
export interface ApprovalRequest {
	/** Unique identifier, e.g. `apr-001`. */
	id: string;
	/** The team this approval belongs to. */
	teamId: string;
	/** Task whose plan is under review. */
	taskId: string;
	/** Role or identity that submitted the plan. */
	submittedBy: string;
	/** Path to the plan artifact. */
	artifact: string;
	/** Current approval state. */
	status: "pending" | "approved" | "rejected";
	/** Role or identity of the reviewer (set when resolved). */
	reviewedBy?: string;
	/** Feedback from the reviewer (used on rejection). */
	feedback?: string;
	/** ISO 8601 timestamp — when the request was created. */
	createdAt: string;
	/** ISO 8601 timestamp — when the request was approved or rejected. */
	resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** User-supplied configuration when creating a team. */
export interface TeamConfig {
	/** Optional display name; generated from objective if omitted. */
	name?: string;
	/** Repo root paths to make accessible to the team. */
	repoRoots?: string[];
	/** Teammate roles to include on the team. */
	teammates?: string[];
	/** Named template to use for bootstrapping the team. */
	template?: string;
	/** Controls how aggressively approval gates are applied. */
	approvalPolicy?: "strict" | "balanced" | "fast";
}

/** Configuration for a single teammate agent. */
export interface TeammateConfig {
	/** Role identifier for this teammate. */
	role: string;
	/** Custom system prompt; overrides the role default if provided. */
	systemPrompt?: string;
	/** Tool names available to this teammate. */
	tools?: string[];
	/** Working directory for this teammate; defaults to the team's repoRoot. */
	cwd?: string;
	/** Worktree path for write-isolated execution. */
	worktree?: string;
}

// ---------------------------------------------------------------------------
// Response / view types
// ---------------------------------------------------------------------------

/** Compact team summary surfaced to the main Pi session. */
export interface TeamSummary {
	teamId: string;
	name: string;
	status: TeamStatus;
	objective: string;
	currentPhase?: LeaderPhase;
	/** How many tasks are done vs. total. */
	progress: { done: number; total: number };
	/** Per-teammate status snapshot. */
	teammates: Array<{
		name: string;
		status: string;
		currentTask?: string;
		summary?: string;
	}>;
	/** Unresolved task blockers. */
	blockers: Array<{ taskId: string; owner: string; reason: string }>;
	/** Tasks awaiting user or leader approval. */
	approvalsPending: Array<{ taskId: string; owner: string; artifact: string }>;
	nextMilestone?: string;
	lastCheckedAt?: string;
	updatedAt: string;
}

/** Signals emitted since the user's last inspection of a team. */
export interface DeltaResponse {
	teamId: string;
	/** ISO 8601 timestamp — the cursor used to filter signals. */
	since: string;
	signals: Signal[];
	count: number;
}

/** Snapshot of all tasks for a team, with aggregated counts. */
export interface TaskBoard {
	teamId: string;
	tasks: TaskRecord[];
	summary: {
		done: number;
		inProgress: number;
		blocked: number;
		awaitingApproval: number;
		total: number;
	};
}

/** Detailed status of a single teammate. */
export interface TeammateSummary {
	teamId: string;
	name: string;
	role: string;
	status: string;
	currentTask?: {
		id: string;
		title: string;
		status: TaskStatus;
		blocker?: string;
	};
	lastOutput?: string;
	worktree?: string;
	artifacts: string[];
	signalsSinceLastCheck: number;
	updatedAt: string;
}

/** Cross-team overview shown when multiple teams are active. */
export interface MultiTeamDashboard {
	activeTeams: number;
	/** Teams that need user intervention. */
	needsAttention: Array<{
		teamId: string;
		reason: string;
		severity: SignalSeverity;
	}>;
	/** Recent noteworthy updates across all teams. */
	recentUpdates: Array<{
		teamId: string;
		type: string;
		message: string;
	}>;
	/** Teams that are progressing without issues. */
	noAttentionNeeded: Array<{
		teamId: string;
		progress: string;
		status: TeamStatus;
	}>;
}

// ---------------------------------------------------------------------------
// Filter / query types
// ---------------------------------------------------------------------------

/** Filter params for task queries. */
export interface TaskFilter {
	status?: TaskStatus | TaskStatus[];
	owner?: string;
	priority?: "low" | "medium" | "high";
	riskLevel?: RiskLevel;
	approvalRequired?: boolean;
}

/** Filter params for signal queries. */
export interface SignalFilter {
	since?: string;
	until?: string;
	type?: SignalType | SignalType[];
	severity?: SignalSeverity;
	source?: string;
	taskId?: string;
}

/** Filter params for mailbox queries. */
export interface MailboxFilter {
	to?: string;
	from?: string;
	taskId?: string;
	type?: string;
	since?: string;
}

// ---------------------------------------------------------------------------
// Template type
// ---------------------------------------------------------------------------

/** A named preset for bootstrapping a team with a predefined roster. */
export type TeamTemplate = {
	/** Unique key used to reference the template. */
	name: string;
	/** Human-readable description. */
	description: string;
	/** Teammate roles included in this template. */
	roles: TeammateRole[];
};

// ---------------------------------------------------------------------------
// Leader & Teammate runtime types
// ---------------------------------------------------------------------------

/** Tracks the state of a running teammate process. */
export interface TeammateProcess {
	/** Teammate role name. */
	role: string;
	/** The team this teammate belongs to. */
	teamId: string;
	/** Task ID currently assigned to this teammate. */
	taskId?: string;
	/** Process state. */
	state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
	/** PID of the pi subprocess, if running. */
	pid?: number;
	/** Working directory for this teammate. */
	cwd?: string;
	/** ISO 8601 timestamp — when the process started. */
	startedAt?: string;
	/** ISO 8601 timestamp — when the process completed. */
	completedAt?: string;
	/** Output text from the process. */
	output?: string;
	/** Error message if the process failed. */
	error?: string;
}

/** Tracks the state of the leader process for a team. */
export interface LeaderProcess {
	/** The team this leader orchestrates. */
	teamId: string;
	/** Process state. */
	state: 'running' | 'completed' | 'failed' | 'cancelled';
	/** PID of the leader pi subprocess. */
	pid?: number;
	/** ISO 8601 timestamp — when the leader started. */
	startedAt: string;
	/** ISO 8601 timestamp — when the leader completed. */
	completedAt?: string;
}

/** Role-specific system prompt templates for teammates. */
export const TEAMMATE_ROLE_PROMPTS: Record<string, string> = {
	researcher: [
		'You are a research specialist on a team.',
		'Your job is to investigate, gather information, and produce research findings.',
		'Use read, bash (for searching), and other read-only tools to explore the codebase.',
		'Document your findings clearly with specific file paths and code references.',
		'When done, summarize your discoveries concisely.',
	].join('\n'),
	planner: [
		'You are a planning specialist on a team.',
		'Your job is to create detailed implementation plans based on research findings.',
		'Break work into clear, actionable steps with dependencies.',
		'Identify risks and suggest mitigations.',
		'Produce plans as structured markdown documents.',
	].join('\n'),
	backend: [
		'You are a backend developer on a team.',
		'Your job is to implement server-side code: APIs, services, database changes, etc.',
		'Write clean, tested, production-ready code.',
		'Follow existing code patterns and conventions in the project.',
		'Document any API contracts or interfaces you create.',
	].join('\n'),
	frontend: [
		'You are a frontend developer on a team.',
		'Your job is to implement user-facing code: components, pages, hooks, styles, etc.',
		'Write clean, accessible, production-ready code.',
		'Follow existing component patterns and styling conventions.',
		'Ensure your work matches any API contracts provided.',
	].join('\n'),
	reviewer: [
		'You are a code reviewer on a team.',
		'Your job is to review code changes for correctness, security, and quality.',
		'Read the specified files and check for: logic errors, security issues,',
		'missing error handling, style violations, and incomplete implementations.',
		'Produce a structured review with actionable feedback.',
	].join('\n'),
	tester: [
		'You are a test engineer on a team.',
		'Your job is to write and run tests for the implemented code.',
		'Create unit tests, integration tests, and edge case tests.',
		'Follow existing test patterns and frameworks in the project.',
		'Report test results clearly.',
	].join('\n'),
	docs: [
		'You are a documentation specialist on a team.',
		'Your job is to write and update documentation.',
		'Create clear READMEs, API docs, and inline code documentation.',
		'Follow existing documentation conventions in the project.',
	].join('\n'),
};

/** Watch mode subscription state. */
export interface WatchSubscription {
	/** The team being watched. */
	teamId: string;
	/** ISO 8601 timestamp — last signal cursor. */
	lastCursor: string;
	/** Polling interval handle. */
	intervalHandle?: ReturnType<typeof setInterval>;
	/** Whether the watch is active. */
	active: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Predefined team templates.
 *
 * - `fullstack` — API + UI feature work
 * - `research`  — investigation, RFCs, migration planning
 * - `refactor`  — broad internal refactors
 */
export const TEAM_TEMPLATES: Record<string, TeamTemplate> = {
	fullstack: {
		name: "fullstack",
		description: "Feature work spanning API and UI layers",
		roles: ["backend", "frontend", "reviewer"],
	},
	research: {
		name: "research",
		description: "Investigation, RFC authoring, or migration planning",
		roles: ["researcher", "docs", "reviewer"],
	},
	refactor: {
		name: "refactor",
		description: "Broad internal refactoring with test coverage",
		roles: ["planner", "backend", "tester", "reviewer"],
	},
};

/**
 * Signal types that should be forwarded to the main Pi session automatically
 * (i.e., pushed without the user polling).
 */
export const BUBBLE_SIGNAL_TYPES: SignalType[] = [
	"approval_requested",
	"blocked",
	"team_summary",
	"team_completed",
	"error",
];

/**
 * Sort order for task statuses — lower number = shown first.
 * Useful when rendering a task board.
 */
export const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
	in_progress: 0,
	blocked: 1,
	awaiting_approval: 2,
	in_review: 3,
	planning: 4,
	ready: 5,
	todo: 6,
	done: 7,
	cancelled: 8,
};
