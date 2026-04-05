import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

const OTHER_OPTION_LABEL = "Other (type your own)";

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

interface SelectionResult {
	cancelled: boolean;
	selectedIndex?: number;
	freeText?: string;
}

function getInitialIndex(recommended: number | undefined, optionCount: number): number {
	if (recommended == null) return 0;
	if (recommended < 0 || recommended >= optionCount) return 0;
	return recommended;
}

function normalizeText(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

async function askSingleQuestion(
	ui: ExtensionUIContext,
	question: PlannerAskQuestion,
): Promise<PlannerAskAnswer> {
	const baseOptions = question.options ?? [];
	const optionLabels = baseOptions.map((option) => option.label);
	const supportsFreeText = question.allowFreeText === true || optionLabels.length === 0;

	if (supportsFreeText && optionLabels.length > 0) {
		optionLabels.push(OTHER_OPTION_LABEL);
	}

	const result = await ui.custom<SelectionResult>((tui, theme, _keybindings, done) => {
		let cursorIndex = getInitialIndex(question.recommended, optionLabels.length);
		let freeTextMode = optionLabels.length === 0;
		let cachedRenderedLines: string[] | undefined;
		let cachedRenderedWidth: number | undefined;

		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		editor.setText("");

		const requestUiRerender = () => {
			cachedRenderedLines = undefined;
			cachedRenderedWidth = undefined;
			tui.requestRender();
		};

		editor.onChange = () => {
			requestUiRerender();
		};

		editor.onSubmit = (value) => {
			const freeText = normalizeText(value);
			if (!freeText) {
				requestUiRerender();
				return;
			}

			done({
				cancelled: false,
				selectedIndex: freeTextMode ? undefined : cursorIndex,
				freeText,
			});
		};

		const render = (width: number): string[] => {
			if (cachedRenderedLines && cachedRenderedWidth === width) return cachedRenderedLines;

			const renderedLines: string[] = [];
			const addLine = (line: string) => renderedLines.push(truncateToWidth(line, width));

			addLine(theme.fg("accent", "─".repeat(width)));
			addLine("");
			addLine(theme.fg("text", truncateToWidth(question.question, width)));
			addLine("");

			if (!freeTextMode) {
				optionLabels.map((label, i) => {
					const isSelected = i === cursorIndex;
					const isRecommended = question.recommended === i;
					const prefix = isSelected ? "→ " : "  ";
					const bullet = isSelected ? "●" : "○";
					const displayLabel = isRecommended ? `${label} (Recommended)` : label;
					const prefixText = isSelected ? theme.fg("accent", prefix) : prefix;
					const bulletText = isSelected ? theme.fg("accent", bullet) : bullet;
					const optionText = isSelected ? theme.fg("accent", displayLabel) : theme.fg("text", displayLabel);
					addLine(`${prefixText}${bulletText} ${optionText}`);
				});

				addLine("");
				addLine(theme.fg("dim", supportsFreeText ? " ↑↓/jk move • Enter confirm • Tab type • Esc cancel" : " ↑↓/jk move • Enter confirm • Esc cancel"));
			} else {
				addLine(theme.fg("muted", " Type your answer below:"));
				addLine("");
				const currentValue = editor.getText().trim();
				addLine(theme.fg("text", currentValue.length > 0 ? currentValue : "…"));
				addLine("");
				addLine(theme.fg("dim", " Type answer • Enter confirm • Esc cancel"));
			}

			addLine(theme.fg("accent", "─".repeat(width)));
			cachedRenderedLines = renderedLines;
			cachedRenderedWidth = width;
			return renderedLines;
		};

		const handleInput = (data: string) => {
			if (freeTextMode) {
				if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
					done({ cancelled: true });
					return;
				}

				editor.handleInput(data);
				requestUiRerender();
				return;
			}

			if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
				done({ cancelled: true });
				return;
			}

			if (matchesKey(data, Key.up) || data === "k") {
				cursorIndex = Math.max(0, cursorIndex - 1);
				requestUiRerender();
				return;
			}

			if (matchesKey(data, Key.down) || data === "j") {
				cursorIndex = Math.min(optionLabels.length - 1, cursorIndex + 1);
				requestUiRerender();
				return;
			}

			if (supportsFreeText && matchesKey(data, Key.tab)) {
				freeTextMode = true;
				editor.setText("");
				requestUiRerender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				const selectedLabel = optionLabels[cursorIndex];
				if (supportsFreeText && selectedLabel === OTHER_OPTION_LABEL) {
					freeTextMode = true;
					editor.setText("");
					requestUiRerender();
					return;
				}

				done({ cancelled: false, selectedIndex: cursorIndex });
			}
		};

		return {
			render,
			invalidate: () => {
				cachedRenderedLines = undefined;
				cachedRenderedWidth = undefined;
			},
			handleInput,
		};
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
		if (acc.some((a) => a.cancelled)) return acc; // early exit
		const answer = await askSingleQuestion(ui, question);
		return [...acc, answer];
	}, Promise.resolve([] as PlannerAskAnswer[]));
}
