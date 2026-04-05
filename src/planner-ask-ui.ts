import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { askSelectOrFreeText, normalizeText } from "./select-or-free-text-ui";

export interface PlannerAskOption {
	label: string;
}

export interface PlannerAskQuestion {
	id: string;
	question: string;
	options?: PlannerAskOption[];
	recommended?: number;
	allowFreeText?: boolean;
}

export interface PlannerAskAnswer {
	id: string;
	question: string;
	selectedOption?: string;
	freeText?: string;
	cancelled: boolean;
}

async function askSingleQuestion(
	ui: ExtensionUIContext,
	question: PlannerAskQuestion,
): Promise<PlannerAskAnswer> {
	const baseOptions = question.options ?? [];
	const result = await askSelectOrFreeText(ui, {
		question: question.question,
		options: baseOptions,
		recommended: question.recommended,
		allowFreeText: question.allowFreeText,
	});

	if (result.cancelled) {
		return {
			id: question.id,
			question: question.question,
			cancelled: true,
		};
	}

	const freeText = normalizeText(result.freeText ?? "");
	const selectedOption =
		result.selectedIndex == null || result.selectedIndex >= baseOptions.length
			? undefined
			: baseOptions[result.selectedIndex]?.label;

	return {
		id: question.id,
		question: question.question,
		selectedOption,
		freeText,
		cancelled: false,
	};
}

export async function askPlannerQuestions(
	ui: ExtensionUIContext,
	questions: PlannerAskQuestion[],
): Promise<PlannerAskAnswer[]> {
	return questions.reduce(async (accPromise, question) => {
		const acc = await accPromise;
		if (acc.some((a) => a.cancelled)) return acc;
		const answer = await askSingleQuestion(ui, question);
		return [...acc, answer];
	}, Promise.resolve([] as PlannerAskAnswer[]));
}
