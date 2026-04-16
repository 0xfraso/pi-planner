import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export const OTHER_OPTION_LABEL = "Other (type your own)";

export interface SelectOrFreeTextOption {
	label: string;
}

export interface SelectOrFreeTextResult {
	cancelled: boolean;
	selectedIndex?: number;
	freeText?: string;
}

export interface SelectOrFreeTextConfig {
	question: string;
	options?: SelectOrFreeTextOption[];
	recommended?: number;
	allowFreeText?: boolean;
	/** Maximum lines to show for the question text (default: 25) */
	maxQuestionLines?: number;
}

function getInitialIndex(recommended: number | undefined, optionCount: number): number {
	if (recommended == null) return 0;
	if (recommended < 0 || recommended >= optionCount) return 0;
	return recommended;
}

export function normalizeText(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export async function askSelectOrFreeText(
	ui: ExtensionUIContext,
	config: SelectOrFreeTextConfig,
): Promise<SelectOrFreeTextResult> {
	const baseOptions = config.options ?? [];
	const optionLabels = baseOptions.map((option) => option.label);
	const supportsFreeText = true; // Always allow free text
	const maxQuestionLines = config.maxQuestionLines ?? 25;

	if (optionLabels.length > 0) {
		optionLabels.push(OTHER_OPTION_LABEL);
	}

	return ui.custom<SelectOrFreeTextResult>((tui, theme, _keybindings, done) => {
		let cursorIndex = getInitialIndex(config.recommended, optionLabels.length);
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

			// Wrap the question text to multiple lines
			const wrappedQuestion = wrapTextWithAnsi(config.question, width);
			const questionLines = wrappedQuestion.slice(0, maxQuestionLines);
			const questionTruncated = wrappedQuestion.length > maxQuestionLines;

			for (const line of questionLines) {
				addLine(theme.fg("text", line));
			}
			if (questionTruncated) {
				addLine(theme.fg("muted", `… (${wrappedQuestion.length - maxQuestionLines} more lines truncated)`));
			}
			addLine("");

			if (!freeTextMode) {
				optionLabels.map((label, i) => {
					const isSelected = i === cursorIndex;
					const isRecommended = config.recommended === i;
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
	}, { overlay: false });
}
