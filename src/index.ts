import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { askPlannerQuestions } from "./planner-ask-ui";
import { askExecuteConfirmation } from "./planner-execute-ui";

const SAFE_COMMAND_PATTERNS: RegExp[] = [
	/^\s*cat\s/,
	/^\s*ls\s/,
	/^\s*grep\s/,
	/^\s*rg\s/,
	/^\s*find\s/,
	/^\s*head\s/,
	/^\s*tail\s/,
	/^\s*wc\s/,
	/^\s*pwd\s*$/,
	/^\s*echo\s/,
	/^\s*printf\s/,
	/^\s*git\s+(status|log|diff|show|branch)\b/,
	/^\s*file\s/,
	/^\s*stat\s/,
	/^\s*du\s/,
	/^\s*df\s/,
	/^\s*which\s/,
	/^\s*type\s/,
	/^\s*env\s*$/,
	/^\s*printenv\s*$/,
	/^\s*uname\s*$/,
	/^\s*whoami\s*$/,
	/^\s*date\s*$/,
];

const MUTATING_GIT_COMMANDS: RegExp[] = [
	/^\s*git\s+commit\b/,
	/^\s*git\s+push\b/,
	/^\s*git\s+pull\b/,
	/^\s*git\s+merge\b/,
	/^\s*git\s+rebase\b/,
	/^\s*git\s+reset\b/,
	/^\s*git\s+cherry-pick\b/,
	/^\s*git\s+branch\s+-D\b/,
	/^\s*git\s+branch\s+-d\b/,
	/^\s*git\s+tag\s+-d\b/,
];

const UNSAFE_SHELL_CHARS = /[|;&`\n]/;
const REDIRECT_PATTERN = />{1,2}/;
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "planner_ask", "planner_execute"];
const PlannerAskOptionParams = Type.Object({
	label: Type.String({ description: "Display label" }),
});
const PlannerAskQuestionParams = Type.Object({
	id: Type.String({ description: "Stable question identifier" }),
	question: Type.String({ description: "Question shown to the user" }),
	options: Type.Optional(
		Type.Array(PlannerAskOptionParams, {
			description: "Available answer choices. Omit this for a pure free-text question.",
			minItems: 1,
		}),
	),
	recommended: Type.Optional(Type.Number({ description: "0-indexed recommended option" })),
	allowFreeText: Type.Optional(
		Type.Boolean({
			description: "When true, allow typed free-text input in addition to choices. If options are omitted, a typed answer is required.",
		}),
	),
});
const PlannerAskParams = Type.Object({
	questions: Type.Array(PlannerAskQuestionParams, {
		description: "One or more structured questions to ask the user",
		minItems: 1,
	}),
});
const PlanExecuteParams = Type.Object({});

type PlanModeState = {
	active: boolean;
};

function isWhitelisted(command: string): boolean {
	const trimmed = command.trim().replace(/\\\n\s*/g, "").replace(/\n\s*/g, " ");
	if (UNSAFE_SHELL_CHARS.test(trimmed)) return false;
	if (REDIRECT_PATTERN.test(trimmed)) return false;
	return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function getLatestPlanModeState(ctx: ExtensionContext): PlanModeState | undefined {
	const entries = ctx.sessionManager.getEntries();
	const stateEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode")
		.pop() as { data?: { active?: boolean } } | undefined;

	if (typeof stateEntry?.data?.active !== "boolean") {
		return undefined;
	}

	return { active: stateEntry.data.active };
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = true;

	function getAllToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function applyTools(): void {
		const available = new Set(getAllToolNames());
		if (planModeEnabled) {
			const tools = PLAN_MODE_TOOLS.filter((toolName) => available.has(toolName));
			pi.setActiveTools(tools);
			return;
		}

		pi.setActiveTools(getAllToolNames());
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			// ctx.ui.setStatus("planner", ctx.ui.theme.fg("warning", "planning"));
			ctx.ui.setWidget("planner", [ctx.ui.theme.fg("warning", "Plan mode active: read-only until planner_execute or /planner")]);
			return;
		}

		// ctx.ui.setStatus("planner", undefined);
		ctx.ui.setWidget("planner", undefined);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			active: planModeEnabled,
			timestamp: Date.now(),
		});
	}

	function setPlanMode(ctx: ExtensionContext, enabled: boolean, notifyMessage?: string): void {
		planModeEnabled = enabled;
		applyTools();
		updateStatus(ctx);
		persistState();
		if (notifyMessage) {
			ctx.ui.notify(notifyMessage, "info");
		}
	}

	pi.registerCommand("planner", {
		description: "Toggle plan mode. In plan mode, only read-only tools are available.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const normalized = (args ?? "").trim().toLowerCase();

			if (normalized === "status") {
				ctx.ui.notify(`Plan mode: ${planModeEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (normalized === "on") {
				setPlanMode(ctx, true, "Plan mode enabled. Write/edit tools blocked.");
				return;
			}

			if (normalized === "off" || normalized === "execute" || normalized === "implement") {
				setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
				return;
			}

			setPlanMode(
				ctx,
				!planModeEnabled,
				planModeEnabled ? "Plan mode disabled. Full tool access restored." : "Plan mode enabled. Write/edit tools blocked.",
			);
		},
	});

	pi.registerCommand("planner_execute", {
		description: "Exit plan mode after confirming planning is complete. Asks for clarifications if user declines.",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!planModeEnabled) {
				ctx.ui.notify("Plan mode is already off. Full tool access is available.", "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("planner_execute requires interactive mode.", "error");
				return;
			}

			const confirmed = await askExecuteConfirmation(ctx.ui, "Planning looks complete. Disable plan mode?");

			if (!confirmed.confirmed) {
				const clarificationOptions = [
					"Unclear requirements or scope",
					"Missing technical details",
					"Edge cases to consider",
					"Dependencies or prerequisites",
					"Other concerns"
				];

				const clarificationChoice = await ctx.ui.select(
					"What would you like me to clarify?",
					clarificationOptions,
					{ timeout: 60000 }
				);

				if (clarificationChoice === undefined) {
					ctx.ui.notify("Plan mode remains on. Take your time to review the plan.", "info");
					return;
				}

				const clarificationPrompts: Record<string, string> = {
					"Unclear requirements or scope": "The user indicated that the requirements or scope are unclear. Please ask specific questions to clarify what's needed before proceeding.",
					"Missing technical details": "The user indicated that technical implementation details are missing. Please explore the codebase more or ask about specific technical decisions.",
					"Edge cases to consider": "The user indicated there are edge cases to consider. Please identify and address potential edge cases in the plan.",
					"Dependencies or prerequisites": "The user indicated there are dependencies or prerequisites to clarify. Please identify what's needed before implementation.",
					"Other concerns": "The user has other concerns about the plan. Please ask what specific issues they'd like addressed."
				};

				ctx.ui.notify(clarificationPrompts[clarificationChoice] || "Please ask what specific issues you'd like addressed.", "info");
				return;
			}

			setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
		},
	});

	pi.registerTool({
		name: "planner_ask",
		label: "Planner Ask",
		description: "Ask the user one or more structured planning questions interactively.",
		parameters: PlannerAskParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "Plan mode is off. Ask the user directly in normal conversation instead." }],
					details: { active: false },
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "planner_ask requires interactive mode." }],
					details: { error: "no_ui" },
					isError: true,
				};
			}

			const answers = await askPlannerQuestions(ctx.ui, params.questions);
			const summary = answers
				.map((answer) =>
					answer.cancelled
						? `${answer.id}: (cancelled)`
						: `${answer.id}: ${answer.selectedOption ?? answer.freeText ?? "(no selection)"}`
				)
				.join("\n");

			return {
				content: [{ type: "text", text: `User answers:\n${summary}` }],
				details: { answers },
			};
		},
	});


	pi.registerTool({
		name: "planner_execute",
		label: "Planner Execute",
		description: "Exit plan mode after confirming that planning is complete.",
		parameters: PlanExecuteParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "Plan mode is already off. Full tool access is available." }],
					details: { active: false },
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "planner_execute requires interactive mode." }],
					details: { error: "no_ui" },
					isError: true,
				};
			}

			const confirmed = await askExecuteConfirmation(ctx.ui, "Planning looks complete. Disable plan mode?");

			if (!confirmed.confirmed) {
				const clarificationOptions = [
					"Unclear requirements or scope",
					"Missing technical details",
					"Edge cases to consider",
					"Dependencies or prerequisites",
					"Other concerns"
				];

				const clarificationChoice = await ctx.ui.select(
					"What would you like me to clarify?",
					clarificationOptions,
					{ timeout: 60000 }
				);

				if (clarificationChoice === undefined) {
					return {
						content: [{ type: "text", text: "Plan mode remains on. Take your time to review the plan." }],
						details: { active: true, confirmed: false, clarificationRequested: false },
					};
				}

				const clarificationPrompts: Record<string, string> = {
					"Unclear requirements or scope": "The user indicated that the requirements or scope are unclear. Please ask specific questions to clarify what's needed before proceeding.",
					"Missing technical details": "The user indicated that technical implementation details are missing. Please explore the codebase more or ask about specific technical decisions.",
					"Edge cases to consider": "The user indicated there are edge cases to consider. Please identify and address potential edge cases in the plan.",
					"Dependencies or prerequisites": "The user indicated there are dependencies or prerequisites to clarify. Please identify what's needed before implementation.",
					"Other concerns": "The user has other concerns about the plan. Please ask what specific issues they'd like addressed."
				};

				const clarificationPrompt = clarificationPrompts[clarificationChoice] || "The user wants clarifications. Please ask what specific issues they'd like addressed.";

				return {
					content: [{ type: "text", text: `Plan mode remains on.\n\n${clarificationPrompt}` }],
					details: {
						active: true,
						confirmed: false,
						clarificationRequested: true,
						clarificationTopic: clarificationChoice
					},
				};
			}

			setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
			return {
				content: [
					{
						type: "text",
						text: "Plan mode is now off. Continue with implementation using the normal tool set.",
					},
				],
				details: { active: false, confirmed: true },
			};
		},
	});

	pi.registerShortcut(Key.ctrl("space"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			setPlanMode(
				ctx,
				!planModeEnabled,
				planModeEnabled ? "Plan mode disabled. Full tool access restored." : "Plan mode enabled. Write/edit tools blocked.",
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		applyTools();
		updateStatus(ctx);

		if (!planModeEnabled) return;

		return {
			systemPrompt:
				`${event.systemPrompt}\n\n[PLAN MODE ACTIVE]\n` +
				`- You are in planning mode.\n` +
				`- Only read-only exploration is allowed.\n` +
				`- Ask the user clarifying questions with planner_ask whenever structured interactive input is useful.\n` +
				`- You may also ask normal conversational questions when that is simpler.\n` +
				`- Use read, grep, find, ls, and safe bash commands to understand the codebase.\n` +
				`- Do not attempt to edit files or run mutating shell commands.\n` +
				`- When you have enough information and are ready to implement, make sure to call planner_execute to disable plan mode.\n`,
		};
	});

	// Prepend [PLAN MODE ACTIVE] to every user message when plan mode is on
	pi.on("input", async (event, ctx) => {
		if (!planModeEnabled) return;
		if (event.source === "extension") return;

		return {
			action: "transform",
			text: `[PLAN MODE ACTIVE]\n\n${event.text}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = getLatestPlanModeState(ctx);
		planModeEnabled = restored?.active ?? true;
		applyTools();
		updateStatus(ctx);
		if (restored) {
			ctx.ui.notify(`Plan mode restored: ${planModeEnabled ? "on" : "off"}.`, "info");
		} else {
			persistState();
		}
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: "Plan mode is active. Use planner_execute or /planner to enable write/edit tools.",
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: string } | undefined)?.command ?? "";

			if (MUTATING_GIT_COMMANDS.some((pattern) => pattern.test(command))) {
				return {
					block: true,
					reason: "Plan mode: mutating git commands are not allowed.",
				};
			}

			if (REDIRECT_PATTERN.test(command)) {
				return {
					block: true,
					reason: "Plan mode: file redirects are not allowed.",
				};
			}

			if (!isWhitelisted(command)) {
				return {
					block: true,
					reason: "Plan mode: only whitelisted read-only bash commands are allowed.",
				};
			}
		}
	});
}
