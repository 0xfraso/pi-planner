import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { askSelectOrFreeText, normalizeText } from "./select-or-free-text-ui";

interface ExecuteSelectionResult {
	confirmed: boolean;
}

export interface ExecuteClarificationResult {
	cancelled: boolean;
	selectedOption?: string;
	freeText?: string;
}

export async function askExecuteConfirmation(
	ui: ExtensionUIContext,
	question: string = "Ready to switch to implementation mode?",
): Promise<ExecuteSelectionResult> {
	const options = ["No", "Yes"];

	const result = await ui.custom<ExecuteSelectionResult>((tui, theme, _keybindings, done) => {
		let cursorIndex = 1;
		let cachedRenderedLines: string[] | undefined;
		let cachedRenderedWidth: number | undefined;

		const requestUiRerender = () => {
			cachedRenderedLines = undefined;
			cachedRenderedWidth = undefined;
			tui.requestRender();
		};

		const render = (width: number): string[] => {
			if (cachedRenderedLines && cachedRenderedWidth === width) return cachedRenderedLines;

			const renderedLines: string[] = [];
			const addLine = (line: string) => renderedLines.push(truncateToWidth(line, width));

			addLine(theme.fg("accent", "─".repeat(width)));
			addLine("");
			addLine(theme.fg("text", truncateToWidth(question, width)));
			addLine("");
			addLine("");

			options.map((option, i) => {
				const isSelected = i === cursorIndex;
				const prefix = isSelected ? "→ " : "  ";
				const bullet = isSelected ? "●" : "○";
				const prefixText = isSelected ? theme.fg("accent", prefix) : prefix;
				const bulletText = isSelected ? theme.fg("accent", bullet) : bullet;
				const optionText = isSelected ? theme.fg("accent", option) : theme.fg("text", option);
				addLine(`${prefixText}${bulletText} ${optionText}`);
			});

			addLine("");
			addLine(theme.fg("dim", " ↑↓/jk or ←/→/hl select • Enter confirm • Esc cancel"));
			addLine(theme.fg("accent", "─".repeat(width)));

			cachedRenderedLines = renderedLines;
			cachedRenderedWidth = width;
			return renderedLines;
		};

		const handleInput = (data: string) => {
			if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
				done({ confirmed: false });
				return;
			}

			if (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.left) || data === "h") {
				cursorIndex = 0;
				requestUiRerender();
				return;
			}

			if (matchesKey(data, Key.down) || data === "j" || matchesKey(data, Key.right) || data === "l") {
				cursorIndex = 1;
				requestUiRerender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				done({ confirmed: cursorIndex === 1 });
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

	return result;
}

export async function askExecuteClarification(
	ui: ExtensionUIContext,
	question: string,
	options: string[],
): Promise<ExecuteClarificationResult> {
	const result = await askSelectOrFreeText(ui, {
		question,
		options: options.map((label) => ({ label })),
		allowFreeText: true,
	});

	return {
		cancelled: result.cancelled,
		selectedOption: result.selectedIndex == null ? undefined : options[result.selectedIndex],
		freeText: normalizeText(result.freeText ?? ""),
	};
}
