import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { askPlannerQuestions } from "./planner-ask-ui";
import { askExecuteClarification, askExecuteConfirmation } from "./planner-execute-ui";
import { loadPlannerSettings, getSettings, setSettings, type PlannerSettings, type PlannerThinkingLevel } from "./planner-settings";

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

type ModelRef = {
	provider: string;
	modelId: string;
};

type PlanModeState = {
	active: boolean;
	previousModel: ModelRef | null;
	previousThinkingLevel: PlannerThinkingLevel | null;
	sessionPlanModel: ModelRef | null;
	sessionPlanThinkingLevel: PlannerThinkingLevel | null;
};

function formatToolList(toolNames: string[]): string {
	if (toolNames.length === 0) return "none";
	if (toolNames.length === 1) return toolNames[0];
	if (toolNames.length === 2) return `${toolNames[0]} and ${toolNames[1]}`;
	return `${toolNames.slice(0, -1).join(", ")}, and ${toolNames[toolNames.length - 1]}`;
}

function getNonBashBlockedTools(settings: PlannerSettings): string[] {
	return settings.blockedTools.filter((tool) => tool !== "bash");
}

function getPlanModeRestrictionSummary(settings: PlannerSettings): string {
	const parts: string[] = [];
	const nonBashBlockedTools = getNonBashBlockedTools(settings);

	if (nonBashBlockedTools.length > 0) {
		parts.push(`Blocked tools: ${formatToolList(nonBashBlockedTools)}.`);
	}

	if (settings.blockedTools.includes("bash")) {
		parts.push("The bash tool is blocked.");
	} else {
		parts.push("Bash is limited to whitelisted read-only commands.");
	}

	return parts.join(" ");
}

function getPlanModeEnabledMessage(settings: PlannerSettings): string {
	return `Plan mode enabled. ${getPlanModeRestrictionSummary(settings)}`;
}

function getPlanModeStatusMessage(): string {
	return "[PLAN MODE ACTIVE]";
}

function getPlanModeExitHint(): string {
	return "Use planner_execute to restore full tool access.";
}

function getBlockedToolReason(toolName: string): string {
	return `Plan mode is active. The ${toolName} tool is blocked. ${getPlanModeExitHint()}`;
}

function getBlockedBashReason(reason: string): string {
	return `Plan mode: ${reason}. ${getPlanModeExitHint()}`;
}

type CommandValidationResult = {
	ok: boolean;
	reason?: string;
};

/**
 * Scans command for unsupported shell constructs.
 * Returns a reason string if something unsafe/unparseable is found, null otherwise.
 */
function findUnsafeShellSyntax(command: string): string | null {
	const SUPPORTED_SEPARATORS = ["&&", "||", ";"];
	let i = 0;
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	while (i < command.length) {
		const ch = command[i]!;

		if (escaped) {
			escaped = false;
			i++;
			continue;
		}

		if (ch === "\\" && !inSingleQuote) {
			escaped = true;
			i++;
			continue;
		}

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			i++;
			continue;
		}

		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			i++;
			continue;
		}

		if (inSingleQuote || inDoubleQuote) {
			i++;
			continue;
		}

		// Check for && and || before checking for single | to avoid false positives
		const ahead2 = command.slice(i, i + 2);
		if (ahead2 === "||" || ahead2 === "&&") { i += 2; continue; }

		// Unsupported constructs — all reason strings
		if (ch === "|") return "pipe operator is not allowed";
		if (ch === "`") return "command substitution (backticks) is not allowed";
		if (ch === "$" && command[i + 1] === "(") return "command substitution ($(...)) is not allowed";
		if (ch === "(") return "subshell grouping is not allowed";
		if (ch === ")") return "unmatched closing parenthesis";
		if (ch === "<") {
			// Redirect stdin or process substitution
			if (command[i + 1] === "(") return "process substitution is not allowed";
			return "input redirect is not allowed";
		}
		if (ch === ">") return "output redirect is not allowed";
		// Background operator (single &) — reject unless it's &&
		if (ch === "&") {
			// Check if it's part of &&
			const ahead = command.slice(i, i + 2);
			if (ahead !== "&&") return "background operator (&) is not allowed";
		}
		if (ch === "\n") return "multiline commands are not allowed";

		i++;
	}

	if (inSingleQuote) return "unclosed single quote";
	if (inDoubleQuote) return "unclosed double quote";

	return null;
}

/**
 * Split a command by &&, ||, or ; (outside of quotes).
 * Returns null if the command contains unsupported shell syntax.
 */
function splitCommandChain(command: string): string[] | null {
	const SUPPORTED_SEPARATORS = ["&&", "||", ";"];
	const segments: string[] = [];
	let current = "";
	let i = 0;
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	while (i < command.length) {
		const ch = command[i]!;

		if (escaped) {
			current += ch;
			escaped = false;
			i++;
			continue;
		}

		if (ch === "\\" && !inSingleQuote) {
			current += ch;
			escaped = true;
			i++;
			continue;
		}

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += ch;
			i++;
			continue;
		}

		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += ch;
			i++;
			continue;
		}

		if (inSingleQuote || inDoubleQuote) {
			current += ch;
			i++;
			continue;
		}

		// Check for supported separators
		const ahead2 = command.slice(i, i + 2);
		if (SUPPORTED_SEPARATORS.includes(ahead2)) {
			segments.push(current.trim());
			current = "";
			i += 2;
			continue;
		}

		if (ch === ";") {
			segments.push(current.trim());
			current = "";
			i++;
			continue;
		}

		current += ch;
		i++;
	}

	segments.push(current.trim());
	return segments;
}

const MUTATING_GIT_PATTERN = /^\s*git\s+(commit|push|pull|merge|rebase|reset|cherry-pick|branch\s+-[dD]|tag\s+-d)\b/;

function isWhitelistedSegment(segment: string, whitelistedCommands: string[]): boolean {
	const trimmed = segment.trim();
	if (!trimmed) return false;

	return whitelistedCommands.some((cmd) => {
		if (cmd === "git") {
			return /^\s*git\s+(status|log|diff|show|branch)\b/.test(trimmed);
		}
		if (cmd === "echo") return /^\s*echo(?:\s|$)/.test(trimmed);
		if (cmd === "printf") return /^\s*printf(?:\s|$)/.test(trimmed);
		// Allow command with trailing space, newline, or end of string
		return new RegExp(`^\\s*${cmd}(?:\\s|$)`).test(trimmed);
	});
}

function isMutatingGitCommand(segment: string): boolean {
	return MUTATING_GIT_PATTERN.test(segment.trim());
}

/**
 * Validate a bash command for plan mode.
 * - Rejects unsupported shell constructs (pipes, redirects, subshells, etc.)
 * - Allows &&, ||, and ; between individually safe commands
 * - Each segment must pass the whitelist check
 * - Each segment must not be a mutating git command
 */
function validateSafeCommand(command: string, whitelistedCommands: string[]): CommandValidationResult {
	// First: reject any unsafe shell syntax outright
	const unsafe = findUnsafeShellSyntax(command);
	if (unsafe) {
		return { ok: false, reason: unsafe };
	}

	// Split into segments by &&, ||, ;
	const segments = splitCommandChain(command);
	if (!segments) {
		// Should not happen since findUnsafeShellSyntax passed, but guard anyway
		return { ok: false, reason: "unsupported command syntax" };
	}

	// Validate each segment
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;

		if (!segment) {
			// Reject empty segments — they indicate malformed input
			return { ok: false, reason: "empty command segment is not allowed" };
		}

		if (isMutatingGitCommand(segment)) {
			return { ok: false, reason: `mutating git commands are not allowed: ${segment.trim()}` };
		}

		if (!isWhitelistedSegment(segment, whitelistedCommands)) {
			return { ok: false, reason: `command not allowed in plan mode: ${segment.trim()}` };
		}
	}

	return { ok: true };
}

function isPlannerThinkingLevel(value: unknown): value is PlannerThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function toModelRef(value: unknown): ModelRef | null {
	if (!value || typeof value !== "object") return null;
	const input = value as { provider?: unknown; modelId?: unknown };
	if (typeof input.provider !== "string" || typeof input.modelId !== "string") return null;
	return { provider: input.provider, modelId: input.modelId };
}

function getLatestPlanModeState(ctx: ExtensionContext): PlanModeState | undefined {
	const entries = ctx.sessionManager.getEntries();
	const stateEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode")
		.pop() as {
			data?: {
				active?: boolean;
				previousModel?: unknown;
				previousThinkingLevel?: unknown;
				sessionPlanModel?: unknown;
				sessionPlanThinkingLevel?: unknown;
			};
		} | undefined;

	if (typeof stateEntry?.data?.active !== "boolean") {
		return undefined;
	}

	return {
		active: stateEntry.data.active,
		previousModel: toModelRef(stateEntry.data.previousModel),
		previousThinkingLevel: isPlannerThinkingLevel(stateEntry.data.previousThinkingLevel) ? stateEntry.data.previousThinkingLevel : null,
		sessionPlanModel: toModelRef(stateEntry.data.sessionPlanModel),
		sessionPlanThinkingLevel: isPlannerThinkingLevel(stateEntry.data.sessionPlanThinkingLevel) ? stateEntry.data.sessionPlanThinkingLevel : null,
	};
}

function sameModelRef(a: ModelRef | null, b: ModelRef | null): boolean {
	if (a === null || b === null) return a === b;
	return a.provider === b.provider && a.modelId === b.modelId;
}

function getCurrentModelRef(ctx: ExtensionContext): ModelRef | null {
	if (!ctx.model) return null;
	return { provider: ctx.model.provider, modelId: ctx.model.id };
}

function resolveConfiguredPlanModel(settings: PlannerSettings): ModelRef | null {
	if (!settings.planModelProvider || !settings.planModelId) return null;
	return {
		provider: settings.planModelProvider,
		modelId: settings.planModelId,
	};
}

function buildSystemPromptAdditions(settings: PlannerSettings): string {
	if (settings.systemPrompt !== null) {
		return settings.systemPrompt;
	}

	let additions = "";
	const nonBashBlockedTools = getNonBashBlockedTools(settings);

	if (settings.showPlanModePrefix) {
		additions += `[PLAN MODE ACTIVE]\n`;
	}

	additions += `- You are in planning mode.\n`;
	additions += `- Focus on understanding the task, exploring the codebase, and planning before implementation.\n`;
	additions += `- Ask the user clarifying questions with planner_ask whenever structured interactive input is useful.\n`;
	additions += `- You may also ask normal conversational questions when that is simpler.\n`;

	if (nonBashBlockedTools.length > 0) {
		additions += `- Blocked tools in this mode: ${formatToolList(nonBashBlockedTools)}.\n`;
	} else {
		additions += `- No non-bash tools are blocked via planner.blockedTools.\n`;
	}

	if (settings.blockedTools.includes("bash")) {
		additions += `- The bash tool is blocked in this mode.\n`;
	} else {
		additions += `- If you use bash, only whitelisted read-only commands are allowed.\n`;
	}

	additions += `- Respect the configured tool restrictions instead of assuming a fixed read-only tool set.\n`;
	additions += `- When you have enough information and are ready to implement, make sure to call planner_execute to disable plan mode.\n`;

	if (settings.systemPromptAdditions) {
		additions += `\n${settings.systemPromptAdditions}\n`;
	}

	return additions;
}


export default function plannerExtension(pi: ExtensionAPI): void {
	// Load settings on extension initialization
	const settings = loadPlannerSettings();
	setSettings(settings);

	let planModeEnabled = settings.defaultMode === "plan";
	let previousModel: ModelRef | null = null;
	let previousThinkingLevel: PlannerThinkingLevel | null = null;
	let sessionPlanModel: ModelRef | null = null;
	let sessionPlanThinkingLevel: PlannerThinkingLevel | null = null;
	let currentPlanThinkingLevel: PlannerThinkingLevel | null = null;
	let suppressPlanModelCapture = false;

	function getAllToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function resolveEffectivePlanModel(settings: PlannerSettings): ModelRef | null {
		return sessionPlanModel ?? resolveConfiguredPlanModel(settings);
	}

	function resolveEffectivePlanThinking(settings: PlannerSettings): PlannerThinkingLevel | null {
		return sessionPlanThinkingLevel ?? settings.planThinkingLevel;
	}

	async function applyPlanModeModelAndThinking(ctx: ExtensionContext): Promise<void> {
		const currentSettings = getSettings();
		const targetModel = resolveEffectivePlanModel(currentSettings);
		const currentModel = getCurrentModelRef(ctx);

		if (targetModel && !sameModelRef(targetModel, currentModel)) {
			const model = ctx.modelRegistry.find(targetModel.provider, targetModel.modelId);
			if (!model) {
				ctx.ui.notify(`Planner plan model not found: ${targetModel.provider}/${targetModel.modelId}`, "warning");
			} else {
				suppressPlanModelCapture = true;
				try {
					const success = await pi.setModel(model);
					if (!success) {
						ctx.ui.notify(`Planner plan model is unavailable: ${targetModel.provider}/${targetModel.modelId}`, "warning");
					}
				} finally {
					suppressPlanModelCapture = false;
				}
			}
		}

		const targetThinking = resolveEffectivePlanThinking(currentSettings);
		if (targetThinking && pi.getThinkingLevel() !== targetThinking) {
			pi.setThinkingLevel(targetThinking);
		}
		currentPlanThinkingLevel = pi.getThinkingLevel();
	}

	async function restorePreviousModelAndThinking(ctx: ExtensionContext): Promise<void> {
		if (previousModel && !sameModelRef(previousModel, getCurrentModelRef(ctx))) {
			const model = ctx.modelRegistry.find(previousModel.provider, previousModel.modelId);
			if (!model) {
				ctx.ui.notify(`Planner could not restore previous model: ${previousModel.provider}/${previousModel.modelId}`, "warning");
			} else {
				suppressPlanModelCapture = true;
				try {
					const success = await pi.setModel(model);
					if (!success) {
						ctx.ui.notify(`Planner could not restore previous model: ${previousModel.provider}/${previousModel.modelId}`, "warning");
					}
				} finally {
					suppressPlanModelCapture = false;
				}
			}
		}

		if (previousThinkingLevel !== null && pi.getThinkingLevel() !== previousThinkingLevel) {
			pi.setThinkingLevel(previousThinkingLevel);
		}
		currentPlanThinkingLevel = null;
	}

	function syncPlanThinkingOverride(): void {
		if (!planModeEnabled || !getSettings().enabled) return;
		const currentThinkingLevel = pi.getThinkingLevel();
		if (currentPlanThinkingLevel === currentThinkingLevel) return;
		sessionPlanThinkingLevel = currentThinkingLevel;
		currentPlanThinkingLevel = currentThinkingLevel;
		persistState();
	}

	function applyTools(): void {
		const currentSettings = getSettings();

		if (!currentSettings.enabled) {
			pi.setActiveTools(getAllToolNames());
			return;
		}

		if (planModeEnabled) {
			const allowedTools = getAllToolNames().filter((tool) => !currentSettings.blockedTools.includes(tool));
			pi.setActiveTools(allowedTools);
			return;
		}

		pi.setActiveTools(getAllToolNames());
	}

	function updateStatus(ctx: ExtensionContext): void {
		const currentSettings = getSettings();

		if (planModeEnabled && currentSettings.enabled) {
			ctx.ui.setWidget("planner", [
				ctx.ui.theme.fg("warning", getPlanModeStatusMessage()),
			]);
			return;
		}

		ctx.ui.setWidget("planner", undefined);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			active: planModeEnabled,
			previousModel,
			previousThinkingLevel,
			sessionPlanModel,
			sessionPlanThinkingLevel,
			timestamp: Date.now(),
		});
	}

	async function setPlanMode(ctx: ExtensionContext, enabled: boolean, notifyMessage?: string): Promise<void> {
		if (enabled === planModeEnabled) {
			applyTools();
			updateStatus(ctx);
			persistState();
			if (notifyMessage) {
				ctx.ui.notify(notifyMessage, "info");
			}
			return;
		}

		if (enabled) {
			previousModel = getCurrentModelRef(ctx);
			previousThinkingLevel = pi.getThinkingLevel();
			planModeEnabled = true;
			await applyPlanModeModelAndThinking(ctx);
		} else {
			await restorePreviousModelAndThinking(ctx);
			planModeEnabled = false;
			previousModel = null;
			previousThinkingLevel = null;
		}

		applyTools();
		updateStatus(ctx);
		persistState();
		if (notifyMessage) {
			ctx.ui.notify(notifyMessage, "info");
		}
	}

	pi.registerCommand("planner", {
		description: "Toggle plan mode. In plan mode, configured tool restrictions are applied.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const normalized = (args ?? "").trim().toLowerCase();
			const currentSettings = getSettings();

			if (!currentSettings.enabled) {
				ctx.ui.notify("Planner extension is disabled. Set planner.enabled to true in settings.", "info");
				return;
			}

			if (normalized === "status") {
				ctx.ui.notify(`Plan mode: ${planModeEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (normalized === "on") {
				await setPlanMode(ctx, true, getPlanModeEnabledMessage(currentSettings));
				return;
			}

			if (normalized === "off" || normalized === "execute" || normalized === "implement") {
				await setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
				return;
			}

			await setPlanMode(
				ctx,
				!planModeEnabled,
				planModeEnabled ? "Plan mode disabled. Full tool access restored." : getPlanModeEnabledMessage(currentSettings),
			);
		},
	});

	pi.registerCommand("planner_execute", {
		description: "Exit plan mode after confirming planning is complete. Asks for clarifications if user declines.",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const currentSettings = getSettings();

			if (!currentSettings.enabled) {
				ctx.ui.notify("Planner extension is disabled.", "info");
				return;
			}

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
				const clarification = await askExecuteClarification(
					ctx.ui,
					"What would you like me to clarify?",
					currentSettings.clarificationOptions,
				);

				const clarificationText = clarification.selectedOption ?? clarification.freeText;
				if (clarification.cancelled || !clarificationText) {
					ctx.ui.notify("Plan mode remains on. Take your time to review the plan.", "info");
					return;
				}

				ctx.ui.notify(`Please clarify: ${clarificationText}`, "info");
				return;
			}

			await setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
			// Trigger agent to start implementation (command mode: user confirmed)
			pi.sendMessage(
				{ customType: "planner-execute", content: "Plan mode disabled. Begin implementation.", display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerTool({
		name: "planner_ask",
		label: "Planner Ask",
		description: "Ask the user one or more structured planning questions interactively.",
		parameters: PlannerAskParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentSettings = getSettings();

			if (!currentSettings.enabled) {
				return {
					content: [{ type: "text", text: "Planner extension is disabled." }],
					details: { active: false, enabled: false },
				};
			}

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
			const currentSettings = getSettings();

			if (!currentSettings.enabled) {
				return {
					content: [{ type: "text", text: "Planner extension is disabled." }],
					details: { active: false, enabled: false },
				};
			}

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
				const clarification = await askExecuteClarification(
					ctx.ui,
					"What would you like me to clarify?",
					currentSettings.clarificationOptions,
				);

				const clarificationText = clarification.selectedOption ?? clarification.freeText;
				if (clarification.cancelled || !clarificationText) {
					return {
						content: [{ type: "text", text: "Plan mode remains on. Take your time to review the plan." }],
						details: { active: true, confirmed: false, clarificationRequested: false },
					};
				}

				return {
					content: [{ type: "text", text: `Plan mode remains on.\n\nPlease clarify: ${clarificationText}` }],
					details: {
						active: true,
						confirmed: false,
						clarificationRequested: true,
						clarificationTopic: clarificationText,
						clarificationSelection: clarification.selectedOption,
						clarificationFreeText: clarification.freeText,
					},
				};
			}

			await setPlanMode(ctx, false, "Plan mode disabled. Full tool access restored.");
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
			const currentSettings = getSettings();

			if (!currentSettings.enabled) return;

			await setPlanMode(
				ctx,
				!planModeEnabled,
				planModeEnabled ? "Plan mode disabled. Full tool access restored." : getPlanModeEnabledMessage(currentSettings),
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		applyTools();
		updateStatus(ctx);

		const currentSettings = getSettings();

		if (!currentSettings.enabled || !planModeEnabled) return;

		syncPlanThinkingOverride();
		const plannerPrompt = buildSystemPromptAdditions(currentSettings);
		return {
			systemPrompt: currentSettings.systemPrompt !== null ? plannerPrompt : `${event.systemPrompt}\n\n${plannerPrompt}`,
		};
	});

	// Prepend [PLAN MODE ACTIVE] to user messages only when configured and plan mode is on
	pi.on("input", async (event) => {
		const currentSettings = getSettings();

		if (!currentSettings.enabled || !planModeEnabled) return;
		if (!currentSettings.showPlanModePrefix) return;
		if (event.source === "extension") return;

		return {
			action: "transform",
			text: `[PLAN MODE ACTIVE]\n\n${event.text}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const settings = loadPlannerSettings(ctx.cwd);
		setSettings(settings);

		const restored = getLatestPlanModeState(ctx);
		planModeEnabled = restored?.active ?? settings.defaultMode === "plan";
		previousModel = restored?.previousModel ?? null;
		previousThinkingLevel = restored?.previousThinkingLevel ?? null;
		sessionPlanModel = restored?.sessionPlanModel ?? null;
		sessionPlanThinkingLevel = restored?.sessionPlanThinkingLevel ?? null;
		currentPlanThinkingLevel = planModeEnabled ? pi.getThinkingLevel() : null;
		if (settings.enabled && planModeEnabled && !restored) {
			previousModel = getCurrentModelRef(ctx);
			previousThinkingLevel = pi.getThinkingLevel();
			await applyPlanModeModelAndThinking(ctx);
		}

		applyTools();
		updateStatus(ctx);

		if (restored) {
			ctx.ui.notify(`Plan mode restored: ${planModeEnabled ? "on" : "off"}.`, "info");
		} else if (settings.enabled) {
			persistState();
		}
	});

	pi.on("model_select", async (event) => {
		if (!getSettings().enabled || !planModeEnabled || suppressPlanModelCapture) return;
		if (event.source === "restore") return;

		sessionPlanModel = { provider: event.model.provider, modelId: event.model.id };
		persistState();
	});

	pi.on("tool_call", async (event) => {
		const currentSettings = getSettings();

		if (!currentSettings.enabled || !planModeEnabled) return;

		// Block configured tools
		if (currentSettings.blockedTools.includes(event.toolName)) {
			return {
				block: true,
				reason: getBlockedToolReason(event.toolName),
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: string } | undefined)?.command ?? "";
			const result = validateSafeCommand(command, currentSettings.whitelistedCommands);

			if (!result.ok) {
				return {
					block: true,
					reason: getBlockedBashReason(result.reason ?? "unsafe command"),
				};
			}
		}
	});
}
