/**
 * Pi Teams — Extension Entry Point
 *
 * Multi-agent team coordination for Pi sessions. Allows the LLM to spawn and
 * manage background teams of sub-agents that work concurrently on complex tasks.
 *
 * Registers:
 *  - 12+ LLM-callable tools  (team_create, team_status, team_list, team_watch, ...)
 *  - 1   slash command       (/team)
 *  - 4   lifecycle handlers  (session_start, session_switch, agent_end, session_shutdown)
 */

import type { ExtensionAPI, ExtensionContext, SessionSwitchEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import { TeamStore } from "./core/store.js";
import { TeamManager } from "./managers/team-manager.js";
import { TaskManager } from "./managers/task-manager.js";
import { SignalManager } from "./managers/signal-manager.js";
import { MailboxManager } from "./managers/mailbox-manager.js";
import { ApprovalManager } from "./managers/approval-manager.js";
import {
	formatDashboard,
	formatSignals,
	formatTaskBoard,
	formatTeamSummary,
	formatTeammateSummary,
} from "./ui/formatters.js";
import { updateTeamWidget } from "./ui/widget.js";
import { LeaderRuntime } from "./runtime/leader-runtime.js";
import { WatchManager } from "./runtime/watch-mode.js";

// ---------------------------------------------------------------------------
// /team subcommand definitions — single source of truth for autocomplete + handler
// ---------------------------------------------------------------------------

const TEAM_SUBCOMMANDS = [
	{ value: "create", label: "create", description: "Create a new team", needsTeamId: false },
	{ value: "status", label: "status", description: "Show team summary", needsTeamId: true },
	{ value: "tasks", label: "tasks", description: "Show task board", needsTeamId: true },
	{ value: "signals", label: "signals", description: "Show recent signals", needsTeamId: true },
	{ value: "ask", label: "ask", description: "Ask leader or teammate a question", needsTeamId: true },
	{ value: "stop", label: "stop", description: "Stop a running team", needsTeamId: true },
	{ value: "resume", label: "resume", description: "Resume a stopped team", needsTeamId: true },
	{ value: "watch", label: "watch", description: "Start live monitoring", needsTeamId: true },
	{ value: "unwatch", label: "unwatch", description: "Stop live monitoring", needsTeamId: false },
] as const;

const TEAM_ID_SUBCOMMANDS: ReadonlySet<string> = new Set(
	TEAM_SUBCOMMANDS.filter((s) => s.needsTeamId).map((s) => s.value),
);

// ---------------------------------------------------------------------------
// Manager bundle — initialized on session_start / session_switch
// ---------------------------------------------------------------------------

/** All manager instances bundled together for easy access. */
type ManagerBundle = {
	store: TeamStore;
	teamManager: TeamManager;
	taskManager: TaskManager;
	signalManager: SignalManager;
	mailboxManager: MailboxManager;
	approvalManager: ApprovalManager;
	leaderRuntime: LeaderRuntime;
	watchManager: WatchManager;
};

let managers: ManagerBundle | undefined;

/** (Re-)create all manager instances for the given project root. */
function initManagers(cwd: string): void {
	const store = new TeamStore(cwd);
	const teamManager = new TeamManager(store);
	const taskManager = new TaskManager(store);
	const signalManager = new SignalManager(store);
	const mailboxManager = new MailboxManager(store);
	const approvalManager = new ApprovalManager(store);
	managers = {
		store,
		teamManager,
		taskManager,
		signalManager,
		mailboxManager,
		approvalManager,
		leaderRuntime: new LeaderRuntime(store, teamManager, taskManager, signalManager, mailboxManager),
		watchManager: new WatchManager(store, signalManager),
	};
}

/** Return the active manager bundle, throwing a clear error if not initialized. */
function getManagers(): ManagerBundle {
	if (!managers) {
		throw new Error("Team managers not initialized — is a session active?");
	}
	return managers;
}

// ---------------------------------------------------------------------------
// Widget helpers
// ---------------------------------------------------------------------------

/** Refresh the team status widget with the current list of all teams. */
async function refreshWidget(ctx: ExtensionContext): Promise<void> {
	if (!managers) return;
	try {
		const teams = await managers.teamManager.listTeams();
		updateTeamWidget(ctx, teams);
	} catch {
		// Widget updates are best-effort — never surface errors from here.
	}
}

// ---------------------------------------------------------------------------
// Extension default export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Message renderer for /team command output
	// -------------------------------------------------------------------------

	pi.registerMessageRenderer("team-output", (message, _options, theme) => {
		return new Text(theme.fg("accent", "teams ") + message.content, 0, 0);
	});

	// -------------------------------------------------------------------------
	// Tool: team_create
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description:
			"Create a new background team with a defined objective, optional template, and custom roster. " +
			"Returns a confirmation with the team ID, roster, and initial status.",
		promptSnippet: "Create and launch a new background team for multi-agent work",
		promptGuidelines: [
			"Use team_create when the user wants to start a background team for complex multi-step work",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "What the team should accomplish" }),
			name: Type.Optional(Type.String({ description: "Human-readable team name (generated from objective if omitted)" })),
			template: Type.Optional(
				StringEnum(["fullstack", "research", "refactor"] as const, {
					description: "Named preset that bootstraps the team with a predefined roster",
				}),
			),
			teammates: Type.Optional(
				Type.Array(Type.String(), {
					description: "Teammate role names to include (merged with template roles when both are provided)",
				}),
			),
			repoRoots: Type.Optional(
				Type.Array(Type.String(), {
					description: "Repository root paths accessible to this team",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				const team = await teamManager.createTeam(params.objective, {
					name: params.name,
					template: params.template,
					teammates: params.teammates,
					repoRoots: params.repoRoots,
				});

				await refreshWidget(ctx);

				let leaderLaunchNote = "";
				let effectiveStatus = team.status;
				try {
					await leaderRuntime.launchLeader(team.id);
					effectiveStatus = "running";
				} catch (leaderErr) {
					leaderLaunchNote = `\n\nNote: Leader launch failed: ${leaderErr instanceof Error ? leaderErr.message : String(leaderErr)}. Use team_control to retry.`;
				}

				const rosterLine =
					team.teammates.length > 0
						? `Roster: ${team.teammates.join(", ")}`
						: "Roster: (empty — assign teammates later)";

				const text = [
					`Team created: ${team.name} (${team.id})`,
					`Status: ${effectiveStatus}`,
					rosterLine,
					`Objective: ${team.objective}`,
				].join("\n") + leaderLaunchNote;

				return {
					content: [{ type: "text", text }],
					details: team,
				};
			} catch (err) {
				throw new Error(
					`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_status
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description:
			"Get a concise status summary of a running team, including progress, blockers, pending approvals, and per-teammate snapshots.",
		promptSnippet: "Get a concise status summary of a running team",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager } = getManagers();

			try {
				const summary = await teamManager.getTeamSummary(params.teamId);
				await teamManager.markChecked(params.teamId);
				await refreshWidget(ctx);

				return {
					content: [{ type: "text", text: formatTeamSummary(summary) }],
					details: summary,
				};
			} catch (err) {
				throw new Error(
					`Failed to get team status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_list
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_list",
		label: "List Teams",
		description:
			"List all active teams and their current status. Optionally filter to teams that need attention " +
			"(blocked tasks, pending approvals, or error signals).",
		promptSnippet: "List all active teams and their current status",
		parameters: Type.Object({
			needsAttention: Type.Optional(
				Type.Boolean({
					description: "When true, only return teams that need user intervention",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager } = getManagers();

			try {
				const dashboard = await teamManager.getDashboard();

				if (params.needsAttention) {
					const attentionItems = dashboard.needsAttention;
					if (attentionItems.length === 0) {
						return {
							content: [{ type: "text", text: "No teams currently need attention." }],
							details: dashboard,
						};
					}

					const lines = ["Teams needing attention:", ""];
					for (const item of attentionItems) {
						lines.push(`⚠ ${item.teamId}: ${item.reason}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: dashboard,
					};
				}

				return {
					content: [{ type: "text", text: formatDashboard(dashboard) }],
					details: dashboard,
				};
			} catch (err) {
				throw new Error(
					`Failed to list teams: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_tasks
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_tasks",
		label: "Team Tasks",
		description: "Get the task board for a team, optionally filtered by status.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
			status: Type.Optional(
				StringEnum(
					[
						"todo",
						"ready",
						"planning",
						"awaiting_approval",
						"in_progress",
						"blocked",
						"in_review",
						"done",
						"cancelled",
					] as const,
					{ description: "Filter tasks to this lifecycle status" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { taskManager } = getManagers();

			try {
				const board = await taskManager.getTaskBoard(params.teamId);

				// Apply optional status filter
				const filtered =
					params.status !== undefined
						? {
								...board,
								tasks: board.tasks.filter((t) => t.status === params.status),
							}
						: board;

				return {
					content: [{ type: "text", text: formatTaskBoard(filtered) }],
					details: filtered,
				};
			} catch (err) {
				throw new Error(
					`Failed to get task board: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_signals
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_signals",
		label: "Team Signals",
		description:
			"Get signals (structured events) emitted by a team. By default returns signals since the last check-in.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to query" }),
			sinceLastCheck: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), return only signals since the last time the team was checked. Set false to return all signals.",
				}),
			),
			type: Type.Optional(
				Type.String({
					description: "Filter to a specific signal type (e.g. 'blocked', 'approval_requested')",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { signalManager } = getManagers();

			try {
				// Default sinceLastCheck to true
				const useSinceLastCheck = params.sinceLastCheck !== false;

				let signals;
				if (useSinceLastCheck) {
					signals = await signalManager.getSignalsSinceLastCheck(params.teamId);
				} else {
					signals = await signalManager.getSignals(params.teamId);
				}

				// Apply optional type filter
				if (params.type) {
					signals = signals.filter((s) => s.type === params.type);
				}

				return {
					content: [{ type: "text", text: formatSignals(signals) }],
					details: { signals, count: signals.length },
				};
			} catch (err) {
				throw new Error(
					`Failed to get signals: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_teammate
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_teammate",
		label: "Teammate Status",
		description: "Get a detailed status snapshot for a specific teammate within a team.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			name: Type.String({ description: "The teammate role name (e.g. 'backend', 'frontend', 'researcher')" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager } = getManagers();

			try {
				const summary = await teamManager.getTeammateSummary(params.teamId, params.name);
				if (!summary) {
					throw new Error(
						`Teammate "${params.name}" not found in team "${params.teamId}". Check that the role name and team ID are correct.`,
					);
				}

				return {
					content: [{ type: "text", text: formatTeammateSummary(summary) }],
					details: summary,
				};
			} catch (err) {
				throw new Error(
					`Failed to get teammate status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_ask
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_ask",
		label: "Ask Team",
		description:
			"Ask the team leader or a specific teammate a question. " +
			"Returns a synthesized answer from current team state (tasks, signals, and last output). " +
			"The question is also forwarded to the target's mailbox for async follow-up if they are running.",
		promptSnippet: "Ask leader or teammate a question about their work",
		promptGuidelines: [
			"Use team_ask when the user wants a specific answer about what a teammate is doing or why something is blocked",
			"Prefer team_ask over team_teammate when the user has a concrete question (not just a status check)",
		],
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			target: Type.String({
				description:
					"Who to ask: a teammate role name (e.g. 'backend', 'reviewer') or 'leader' for the team orchestrator",
			}),
			question: Type.String({ description: "The question to ask" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { teamManager, mailboxManager } = getManagers();

			const team = await teamManager.getTeam(params.teamId);
			if (!team) {
				throw new Error(`Team not found: ${params.teamId}`);
			}

			const lines: string[] = [];
			lines.push(`Question for ${params.target} in team ${team.name} (${params.teamId}):`);
			lines.push(`"${params.question}"`);
			lines.push("");

			if (params.target === "leader") {
				// Synthesize answer from full team state
				const summary = await teamManager.getTeamSummary(params.teamId);

				lines.push(`**Answer from current team state:**`);
				lines.push(`Phase: ${summary.currentPhase ?? "unknown"}`);
				lines.push(`Progress: ${summary.progress.done}/${summary.progress.total} tasks done`);

				if (summary.blockers.length > 0) {
					lines.push(`Blockers:`);
					for (const b of summary.blockers) {
						lines.push(`  - ${b.taskId} (${b.owner}): ${b.reason}`);
					}
				} else {
					lines.push(`Blockers: none`);
				}

				if (summary.approvalsPending.length > 0) {
					lines.push(`Approvals pending:`);
					for (const a of summary.approvalsPending) {
						lines.push(`  - ${a.taskId} (${a.owner}): ${a.artifact}`);
					}
				}

				const activeTeammates = summary.teammates.filter(
					(t) => t.status === "in_progress",
				);
				if (activeTeammates.length > 0) {
					lines.push(`Active teammates:`);
					for (const t of activeTeammates) {
						lines.push(`  - ${t.name}: ${t.summary ?? t.currentTask ?? "running"}`);
					}
				}

				if (summary.nextMilestone) {
					lines.push(`Next milestone: ${summary.nextMilestone}`);
				}
			} else {
				// Synthesize answer from teammate state
				const teammate = await teamManager.getTeammateSummary(params.teamId, params.target);
				if (!teammate) {
					throw new Error(
						`Teammate "${params.target}" not found in team "${params.teamId}". ` +
							`Available roles: ${team.teammates.join(", ")}`,
					);
				}

				lines.push(`**Answer from ${params.target}'s current state:**`);
				lines.push(`Status: ${teammate.status}`);

				if (teammate.currentTask) {
					lines.push(
						`Current task: ${teammate.currentTask.id} — ${teammate.currentTask.title} (${teammate.currentTask.status})`,
					);
					if (teammate.currentTask.blocker) {
						lines.push(`Blocker: ${teammate.currentTask.blocker}`);
					}
				} else {
					lines.push(`Current task: none assigned`);
				}

				if (teammate.worktree) {
					lines.push(`Worktree: ${teammate.worktree}`);
				}

				if (teammate.artifacts.length > 0) {
					lines.push(`Artifacts: ${teammate.artifacts.join(", ")}`);
				}

				if (teammate.lastOutput) {
					// Surface the first ~300 chars of the last output as a hint
					const preview = teammate.lastOutput.trim().slice(0, 300);
					lines.push(`Last output preview:`);
					lines.push(preview.replace(/^/gm, "  "));
					if (teammate.lastOutput.length > 300) lines.push("  ...");
				}
			}

			lines.push("");
			lines.push(
				`Note: question forwarded to ${params.target}'s mailbox for explicit follow-up.`,
			);

			// Forward the question via mailbox so the target sees it in their next cycle
			try {
				await mailboxManager.send(params.teamId, {
					from: "user",
					to: params.target,
					type: "question",
					message: params.question,
					attachments: [],
				});
			} catch {
				// Mailbox send is best-effort — don't fail the whole call
			}

			const text = lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { teamId: params.teamId, target: params.target, question: params.question },
			};
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_message
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_message",
		label: "Send Team Message",
		description:
			"Send guidance or a directive to the team leader or a specific teammate via the team mailbox.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			target: Type.String({
				description: "Recipient role name, 'leader' for the team leader, or 'all' to broadcast",
			}),
			message: Type.String({ description: "The message content to send" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { mailboxManager } = getManagers();

			try {
				const msg = await mailboxManager.send(params.teamId, {
					from: "user",
					to: params.target,
					type: "guidance",
					message: params.message,
					attachments: [],
				});

				const text = `Message sent to ${params.target} in team ${params.teamId} (${msg.id}).`;
				return {
					content: [{ type: "text", text }],
					details: msg,
				};
			} catch (err) {
				throw new Error(
					`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_approve
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_approve",
		label: "Approve Plan",
		description:
			"Approve a plan submitted by a teammate for a task that requires sign-off before execution.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			taskId: Type.String({ description: "The task ID whose plan should be approved" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { approvalManager, taskManager } = getManagers();

			try {
				const pending = await approvalManager.getApprovalForTask(params.teamId, params.taskId);
				if (!pending) {
					throw new Error(
						`No approval request found for task "${params.taskId}" in team "${params.teamId}".`,
					);
				}

				const updated = await approvalManager.approve(params.teamId, pending.id, "user");
				await taskManager.updateTask(params.teamId, params.taskId, {
					status: "ready",
					blockers: [],
				});
				await refreshWidget(ctx);

				const text = [
					`Plan approved for task ${params.taskId} in team ${params.teamId}.`,
					`Approval ID: ${updated.id}`,
					`Status: ${updated.status}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to approve plan: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_reject
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_reject",
		label: "Reject Plan",
		description:
			"Reject a submitted plan with actionable feedback so the teammate can revise and resubmit.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			taskId: Type.String({ description: "The task ID whose plan should be rejected" }),
			feedback: Type.String({ description: "Specific feedback explaining what needs to change" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { approvalManager, taskManager } = getManagers();

			try {
				const pending = await approvalManager.getApprovalForTask(params.teamId, params.taskId);
				if (!pending) {
					throw new Error(
						`No approval request found for task "${params.taskId}" in team "${params.teamId}".`,
					);
				}

				const updated = await approvalManager.reject(
					params.teamId,
					pending.id,
					"user",
					params.feedback,
				);
				await taskManager.updateTask(params.teamId, params.taskId, {
					status: "blocked",
					blockers: [params.feedback],
				});
				await refreshWidget(ctx);

				const text = [
					`Plan rejected for task ${params.taskId} in team ${params.teamId}.`,
					`Approval ID: ${updated.id}`,
					`Feedback: ${params.feedback}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to reject plan: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_control
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_control",
		label: "Control Team",
		description: "Stop or resume a team. Use stop to pause execution and resume to continue.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to control" }),
			action: StringEnum(["stop", "resume"] as const, {
				description: "The control action: stop to cancel the team, resume to restart it",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { teamManager, leaderRuntime } = getManagers();

			try {
				let updated;
				if (params.action === "stop") {
					await leaderRuntime.stopTeam(params.teamId);
					updated = await teamManager.stopTeam(params.teamId);
				} else {
					updated = await teamManager.resumeTeam(params.teamId);
					try {
						await leaderRuntime.launchLeader(params.teamId);
					} catch {
						// Non-fatal: the team is resumed even if the leader fails to relaunch.
					}
				}

				await refreshWidget(ctx);

				const text = `Team ${params.teamId} ${params.action === "stop" ? "stopped" : "resumed"}. Status: ${updated.status}`;
				return {
					content: [{ type: "text", text }],
					details: updated,
				};
			} catch (err) {
				throw new Error(
					`Failed to ${params.action} team: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_spawn_teammate
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_spawn_teammate",
		label: "Spawn Teammate",
		description:
			"Spawn a teammate subprocess to work on a specific task. The teammate runs as an isolated pi process with its own context.",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			role: Type.String({ description: "Teammate role (backend, frontend, researcher, reviewer, etc.)" }),
			taskId: Type.String({ description: "The task ID to assign to the teammate" }),
			taskDescription: Type.String({ description: "Full, self-contained description of what the teammate should do" }),
			context: Type.Optional(Type.String({ description: "Additional context (research findings, contracts, etc.)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the teammate process" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				const process = await m.leaderRuntime.spawnTeammate(
					params.teamId,
					params.role,
					params.taskId,
					params.taskDescription,
					params.context,
					params.cwd,
				);
				await refreshWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Teammate ${params.role} spawned for task ${params.taskId} in team ${params.teamId}. PID: ${process.pid ?? "N/A"}`,
						},
					],
					details: process,
				};
			} catch (err) {
				throw new Error(`Failed to spawn teammate: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_memory
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_memory",
		label: "Write Team Memory",
		description:
			"Write durable team knowledge to long-lived memory that persists after the team completes. " +
			"Use 'discoveries' for codebase findings, 'decisions' for choices made and why, " +
			"and 'contracts' for agreed API schemas or interface specifications. " +
			"Content is appended to the named memory document and injected into future teammate contexts.",
		promptSnippet: "Record important team knowledge that persists across team runs",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID" }),
			type: StringEnum(
				["discoveries", "decisions", "contracts"] as const,
				{
					description:
						"Which memory document to write to: 'discoveries' (codebase findings), " +
						"'decisions' (choices + rationale), or 'contracts' (API/interface specs)",
				},
			),
			content: Type.String({
				description: "Content to append to the memory document (Markdown supported)",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { store } = getManagers();

			try {
				const existing =
					await store.loadMemory(
						params.teamId,
						params.type as "discoveries" | "decisions" | "contracts",
					) ?? "";
				const separator = existing.trim() ? "\n\n---\n\n" : "";
				const updated = `${existing}${separator}${params.content}`;
				await store.saveMemory(
					params.teamId,
					params.type as "discoveries" | "decisions" | "contracts",
					updated,
				);

				const text = [
					`Team memory updated: ${params.type} for team ${params.teamId}.`,
					`Document length: ${updated.length} characters.`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: { teamId: params.teamId, type: params.type, length: updated.length },
				};
			} catch (err) {
				throw new Error(
					`Failed to write team memory: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Tool: team_watch
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "team_watch",
		label: "Watch Team",
		description: "Start live monitoring of a team. Shows compact signal updates in a widget below the editor.",
		promptSnippet: "Start streaming live updates for a team",
		parameters: Type.Object({
			teamId: Type.String({ description: "The team ID to watch" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const m = getManagers();
			try {
				await m.watchManager.startWatch(params.teamId, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Now watching team ${params.teamId}. Updates will appear below the editor. Use /team unwatch to stop.`,
						},
					],
					details: { teamId: params.teamId, watching: true },
				};
			} catch (err) {
				throw new Error(`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Slash command: /team
	// -------------------------------------------------------------------------

	/**
	 * /team                      — show dashboard
	 * /team create <objective>   — create a new team
	 * /team status <id>          — show team summary
	 * /team tasks <id>           — show task board
	 * /team signals <id>         — show recent signals
	 * /team stop <id>            — stop a team
	 * /team resume <id>          — resume a team
	 */
	pi.registerCommand("team", {
		description: "Manage background teams. Use /team <subcommand> — or /team for a dashboard.",
		getArgumentCompletions: async (prefix: string) => {
			const parts = prefix.trimStart().split(/\s+/);

			if (parts.length <= 1) {
				const partial = (parts[0] ?? "").toLowerCase();
				const matches = TEAM_SUBCOMMANDS.filter((s) => s.value.startsWith(partial));
				return matches.length > 0 ? matches.map((s) => ({ value: s.value, label: s.label, description: s.description })) : null;
			}

			const sub = parts[0].toLowerCase();
			if (TEAM_ID_SUBCOMMANDS.has(sub) && parts.length === 2) {
				if (!managers) return null;
				try {
					const teams = await managers.teamManager.listTeams();
					const partial = parts[1].toLowerCase();
					const items = teams
						.filter(
							(t) =>
								t.id.toLowerCase().startsWith(partial) ||
								t.name.toLowerCase().startsWith(partial),
						)
						.map((t) => ({
							value: `${sub} ${t.id}`,
							label: t.id,
							description: `${t.name} (${t.status})`,
						}));
					return items.length > 0 ? items : null;
				} catch {
					return null;
				}
			}

			return null;
		},
		handler: async (args, ctx) => {
			if (!managers) {
				ctx.ui.notify("Team managers not initialized", "error");
				return;
			}
			const { teamManager, taskManager, signalManager, leaderRuntime, watchManager } = managers;

			const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase() ?? "";

			switch (subcommand) {
				case "create": {
					const objective = parts.slice(1).join(" ").trim();
					if (!objective) {
						ctx.ui.notify("Usage: /team create <objective>", "warning");
						return;
					}
					try {
						const team = await teamManager.createTeam(objective);
						try {
							await leaderRuntime.launchLeader(team.id);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team "${team.name}" created (${team.id})`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to create team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "status": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team status <id>", "warning");
						return;
					}
					try {
						const summary = await teamManager.getTeamSummary(teamId);
						await teamManager.markChecked(teamId);
						await refreshWidget(ctx);
						pi.sendMessage(
							{ customType: "team-output", content: formatTeamSummary(summary), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get status: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "tasks": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team tasks <id>", "warning");
						return;
					}
					try {
						const board = await taskManager.getTaskBoard(teamId);
						pi.sendMessage(
							{ customType: "team-output", content: formatTaskBoard(board), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get tasks: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "signals": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team signals <id>", "warning");
						return;
					}
					try {
						const signals = await signalManager.getSignalsSinceLastCheck(teamId);
						pi.sendMessage(
							{ customType: "team-output", content: formatSignals(signals), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get signals: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "ask": {
					// /team ask <teamId> <target> <question...>
					const teamId = parts[1];
					const target = parts[2];
					const question = parts.slice(3).join(" ").trim();
					if (!teamId || !target || !question) {
						ctx.ui.notify("Usage: /team ask <teamId> <target> <question>", "warning");
						return;
					}
					try {
						const { teamManager: tm, mailboxManager: mb } = managers;
						const team = await tm.getTeam(teamId);
						if (!team) {
							ctx.ui.notify(`Team not found: ${teamId}`, "error");
							return;
						}
						const lines: string[] = [`Q: "${question}" → ${target}`, ""];
						if (target === "leader") {
							const summary = await tm.getTeamSummary(teamId);
							lines.push(`Phase: ${summary.currentPhase ?? "unknown"}`);
							lines.push(`Progress: ${summary.progress.done}/${summary.progress.total}`);
							if (summary.blockers.length > 0) {
								lines.push(`Blockers: ${summary.blockers.map((b) => b.reason).join("; ")}`);
							}
							if (summary.nextMilestone) lines.push(`Next: ${summary.nextMilestone}`);
						} else {
							const teammate = await tm.getTeammateSummary(teamId, target);
							if (!teammate) {
								ctx.ui.notify(`Teammate "${target}" not found`, "error");
								return;
							}
							lines.push(`Status: ${teammate.status}`);
							if (teammate.currentTask) {
								lines.push(`Task: ${teammate.currentTask.id} — ${teammate.currentTask.title}`);
								if (teammate.currentTask.blocker) lines.push(`Blocker: ${teammate.currentTask.blocker}`);
							}
							if (teammate.lastOutput) {
								lines.push(`Last output: ${teammate.lastOutput.trim().slice(0, 200)}`);
							}
						}
						lines.push("");
						lines.push(`Question forwarded to ${target}'s mailbox.`);
						try {
							await mb.send(teamId, {
								from: "user",
								to: target,
								type: "question",
								message: question,
								attachments: [],
							});
						} catch { /* best effort */ }
						pi.sendMessage(
							{ customType: "team-output", content: lines.join("\n"), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to ask: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "stop": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team stop <id>", "warning");
						return;
					}
					try {
						await leaderRuntime.stopTeam(teamId);
						await teamManager.stopTeam(teamId);
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} stopped`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to stop team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "resume": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team resume <id>", "warning");
						return;
					}
					try {
						await teamManager.resumeTeam(teamId);
						try {
							await leaderRuntime.launchLeader(teamId);
						} catch {
							// non-fatal
						}
						await refreshWidget(ctx);
						ctx.ui.notify(`Team ${teamId} resumed`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to resume team: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "watch": {
					const teamId = parts[1];
					if (!teamId) {
						ctx.ui.notify("Usage: /team watch <id>", "warning");
						return;
					}
					try {
						await watchManager.startWatch(teamId, ctx);
						ctx.ui.notify(`Now watching team ${teamId}`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Failed to start watch: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}

				case "unwatch": {
					watchManager.stopWatch(ctx);
					ctx.ui.notify("Watch stopped", "info");
					break;
				}

				default: {
					// No subcommand or unrecognized — show the dashboard
					try {
						const dashboard = await teamManager.getDashboard();
						pi.sendMessage(
							{ customType: "team-output", content: formatDashboard(dashboard), display: true },
							{ triggerTurn: false },
						);
					} catch (err) {
						ctx.ui.notify(
							`Failed to get dashboard: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					break;
				}
			}
		},
	});

	// -------------------------------------------------------------------------
	// Lifecycle event handlers
	// -------------------------------------------------------------------------

	/** Initialize managers when a session starts. */
	pi.on("session_start", async (_event, ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
		initManagers(ctx.cwd);
		// Fix #1: teammate subprocesses must never spawn their own leader instances.
		// They set PI_TEAM_SUBPROCESS=1 in their env (see spawnPiJsonMode).
		if (!process.env.PI_TEAM_SUBPROCESS && managers) {
			const runningTeams = await managers.teamManager.listTeams({ status: ["running"] });
			for (const team of runningTeams) {
				try {
					await managers.leaderRuntime.launchLeader(team.id);
				} catch {
					// best effort only
				}
			}
		}
		await refreshWidget(ctx);
	});

	/** Re-initialize managers when switching sessions (cwd may differ). */
	pi.on("session_switch", async (_event: SessionSwitchEvent, ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
		initManagers(ctx.cwd);
		await refreshWidget(ctx);
	});

	/** Refresh the widget after every agent turn to reflect any team state changes. */
	pi.on("agent_end", async (_event, ctx) => {
		await refreshWidget(ctx);
	});

	/** Clean up all team processes and watches on shutdown. */
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (managers) {
			await managers.leaderRuntime.cleanup();
			managers.watchManager.cleanup();
		}
	});
}
