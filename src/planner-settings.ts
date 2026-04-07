import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type PlannerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PlannerSettings {
	enabled: boolean;
	defaultOn: boolean;
	showPlanModePrefix: boolean;
	whitelistedCommands: string[];
	blockedTools: string[];
	clarificationOptions: string[];
	planModelProvider: string | null;
	planModelId: string | null;
	planThinkingLevel: PlannerThinkingLevel | null;
	systemPrompt: string | null;      // Override entire system prompt when set
	systemPromptAdditions: string;      // Append to default system prompt (if systemPrompt not set)
}

const DEFAULT_SETTINGS: PlannerSettings = {
	enabled: true,
	defaultOn: false,
	showPlanModePrefix: true,
	whitelistedCommands: [
		"cat",
		"ls",
		"grep",
		"rg",
		"find",
		"head",
		"tail",
		"wc",
		"pwd",
		"echo",
		"printf",
		"git",
		"file",
		"stat",
		"du",
		"df",
		"which",
		"type",
		"env",
		"printenv",
		"uname",
		"whoami",
		"date",
	],
	blockedTools: ["write", "edit"],
	planModelProvider: null,
	planModelId: null,
	planThinkingLevel: null,
	systemPrompt: null,
	clarificationOptions: [
		"Unclear requirements or scope",
		"Missing technical details",
		"Edge cases to consider",
		"Dependencies or prerequisites",
		"Other concerns",
	],
	systemPromptAdditions: "",
};

function getDefaultAgentDir(): string {
	return resolve(process.env.HOME ?? "~", ".pi/agent");
}

function getDefaultCwd(): string {
	return process.cwd();
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
			result[key] = mergeDeep(
				(result[key] as Record<string, unknown>) ?? {},
				source[key] as Record<string, unknown>,
			);
		} else {
			result[key] = source[key];
		}
	}
	return result;
}

export function loadPlannerSettings(cwd?: string, agentDir?: string): PlannerSettings {
	const resolvedCwd = cwd ?? getDefaultCwd();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	// Read global settings
	const globalSettingsPath = resolve(resolvedAgentDir.replace("~", process.env.HOME ?? ""), "settings.json");
	const globalSettings = readJsonFile(globalSettingsPath);

	// Read project settings (if exists)
	const projectSettingsPath = resolve(resolvedCwd, ".pi/settings.json");
	const projectSettings = readJsonFile(projectSettingsPath);

	// Merge: project overrides global
	const mergedSettings = mergeDeep(globalSettings, projectSettings);

	// Extract planner settings
	const plannerConfig = (mergedSettings["planner"] as Record<string, unknown>) ?? {};

	// Merge with defaults
	const finalSettings = {
		...DEFAULT_SETTINGS,
		...plannerConfig,
		whitelistedCommands: (plannerConfig["whitelistedCommands"] as string[] | undefined) ?? DEFAULT_SETTINGS.whitelistedCommands,
		blockedTools: (plannerConfig["blockedTools"] as string[] | undefined) ?? DEFAULT_SETTINGS.blockedTools,
		clarificationOptions: (plannerConfig["clarificationOptions"] as string[] | undefined) ?? DEFAULT_SETTINGS.clarificationOptions,
	};

	return finalSettings as PlannerSettings;
}

// For runtime access (after initial load)
let currentSettings: PlannerSettings = { ...DEFAULT_SETTINGS };

export function getSettings(): PlannerSettings {
	return currentSettings;
}

export function setSettings(settings: PlannerSettings): void {
	currentSettings = settings;
}
