import { UnifiedThemeManager } from "../../utils/theme-detection";

export type ReaderColorScheme = "light" | "dark";

export const READER_HIGHLIGHT_OPACITY_MAP: Record<ReaderColorScheme, string> = {
	light: "0.72",
	dark: "0.68",
};

export const READER_HIGHLIGHT_BLEND_MODE_MAP: Record<ReaderColorScheme, string> = {
	light: "normal",
	dark: "normal",
};

export function readObsidianCssVar(
	styleSource: HTMLElement,
	varName: string,
	fallback: string
): string {
	try {
		const primary = getComputedStyle(styleSource).getPropertyValue(varName).trim();
		if (primary) {
			return primary;
		}
		const bodyValue = getComputedStyle(activeDocument.body).getPropertyValue(varName).trim();
		if (bodyValue) {
			return bodyValue;
		}
		const rootValue = getComputedStyle(activeDocument.documentElement)
			.getPropertyValue(varName)
			.trim();
		return rootValue || fallback;
	} catch {
		return fallback;
	}
}

export function readObsidianColorScheme(): ReaderColorScheme {
	if (
		activeDocument.body.classList.contains("theme-dark") ||
		activeDocument.documentElement.classList.contains("theme-dark")
	) {
		return "dark";
	}
	if (
		activeDocument.body.classList.contains("theme-light") ||
		activeDocument.documentElement.classList.contains("theme-light")
	) {
		return "light";
	}
	return UnifiedThemeManager.getInstance().getCurrentTheme().isDark ? "dark" : "light";
}

function isConcreteCssSizeValue(value: string): boolean {
	return Boolean(value) && !value.includes("var(");
}

function readResolvedStyleSourceFontSize(styleSource: HTMLElement): string | null {
	try {
		const resolvedSize = getComputedStyle(styleSource).fontSize.trim();
		return resolvedSize || null;
	} catch {
		return null;
	}
}

export function readObsidianFontStack(styleSource: HTMLElement): string {
	const fontText = readObsidianCssVar(styleSource, "--font-text", "").trim();
	const fontInterface = readObsidianCssVar(styleSource, "--font-interface", "").trim();
	const baseFont = fontText || fontInterface;
	if (!baseFont) {
		return '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
	}
	return `${baseFont}, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
}

export function readObsidianMonospaceFontStack(styleSource: HTMLElement): string {
	const monoFont = readObsidianCssVar(styleSource, "--font-monospace", "").trim();
	if (!monoFont) {
		return 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace';
	}
	return `${monoFont}, ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
}

export function readObsidianTextFontSize(styleSource: HTMLElement): string {
	const directTextSize = readObsidianCssVar(styleSource, "--font-text-size", "").trim();
	if (isConcreteCssSizeValue(directTextSize)) {
		return directTextSize;
	}

	const directEditorSize = readObsidianCssVar(styleSource, "--editor-font-size", "").trim();
	if (isConcreteCssSizeValue(directEditorSize)) {
		return directEditorSize;
	}

	const resolvedSize = readResolvedStyleSourceFontSize(styleSource);
	if (resolvedSize) {
		return resolvedSize;
	}

	const rawSize = readObsidianCssVar(
		styleSource,
		"--font-text-size",
		readObsidianCssVar(styleSource, "--editor-font-size", "16px")
	).trim();
	return rawSize || "16px";
}

