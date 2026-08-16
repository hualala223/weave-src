import { getReaderHighlightIdentityKey } from "./highlight/highlight-identity";
import type { ReaderColorScheme } from "./reader-theme-tokens";
import type { ReaderHighlight } from "./reader-engine-types";
import type { EpubStrikethroughDisplayMode } from "./types";

export type ReaderFoliateAnnotation = ReaderHighlight & {
	value: string;
	focusColor?: string;
};

export type RenderedReaderFoliateAnnotation = {
	annotation: ReaderFoliateAnnotation;
	renderSignature: string;
};

export function createReaderFoliateAnnotation(
	highlight: ReaderHighlight,
	focusColor?: string
): ReaderFoliateAnnotation {
	const annotation: ReaderFoliateAnnotation = {
		...highlight,
		// Foliate resolves navigation and overlayer keys from `value`; must stay a valid CFI.
		value: highlight.cfiRange,
	};
	if (focusColor) {
		annotation.focusColor = focusColor;
	}
	return annotation;
}

export function composeVisibleAnnotationHighlight(
	persistentHighlight?: ReaderHighlight,
	temporaryHighlight?: ReaderHighlight
): ReaderFoliateAnnotation {
	// Source-focus flashes must render alone so they can fully expire without
	// leaving a persistent focus ring on the stored excerpt highlight.
	if (temporaryHighlight) {
		return createReaderFoliateAnnotation(temporaryHighlight);
	}

	if (persistentHighlight) {
		return createReaderFoliateAnnotation(persistentHighlight);
	}

	throw new Error("Cannot compose annotation without a highlight");
}

export function shouldIncludeHighlightInSidebarSnapshot(
	highlight: Pick<ReaderHighlight, "style">,
	showStrikethroughHighlights: boolean
): boolean {
	return highlight.style !== "strikethrough" || showStrikethroughHighlights;
}

export function isSameFoliateAnnotation(
	a: ReaderFoliateAnnotation,
	b: ReaderFoliateAnnotation
): boolean {
	return (
		a.value === b.value &&
		a.color === b.color &&
		a.style === b.style &&
		a.hasCommentDivider === b.hasCommentDivider &&
		a.focusColor === b.focusColor &&
		a.text === b.text &&
		a.sourceFile === b.sourceFile &&
		a.sourceRef === b.sourceRef &&
		a.excerptId === b.excerptId &&
		a.createdTime === b.createdTime &&
		a.referenceCount === b.referenceCount &&
		a.referenceHeat === b.referenceHeat &&
		a.temporary === b.temporary &&
		a.presentation === b.presentation
	);
}

export function buildAnnotationRenderSignature(input: {
	annotation: ReaderFoliateAnnotation;
	currentStrikethroughPresentation: EpubStrikethroughDisplayMode;
	colorScheme: ReaderColorScheme;
}): string {
	const key = getReaderHighlightIdentityKey(input.annotation);

	return [
		`presentation:${input.annotation.presentation || "highlight"}`,
		`color:${input.annotation.color || "yellow"}`,
		`style:${input.annotation.style || "highlight"}`,
		`comment:${input.annotation.hasCommentDivider ? "visible" : "hidden"}`,
		`references:${input.annotation.referenceCount || 0}`,
		`heat:${input.annotation.referenceHeat || 0}`,
		`focus:${input.annotation.focusColor || ""}`,
		`strikethrough:${input.currentStrikethroughPresentation}`,
		`scheme:${input.colorScheme}`,
		`identity:${key}`,
	].join("|");
}

export function createRenderedFoliateAnnotation(input: {
	persistentHighlight?: ReaderHighlight;
	temporaryHighlight?: ReaderHighlight;
	currentStrikethroughPresentation: EpubStrikethroughDisplayMode;
	colorScheme: ReaderColorScheme;
}): RenderedReaderFoliateAnnotation {
	const annotation = composeVisibleAnnotationHighlight(
		input.persistentHighlight,
		input.temporaryHighlight
	);
	return {
		annotation,
		renderSignature: buildAnnotationRenderSignature({
			annotation,
			currentStrikethroughPresentation: input.currentStrikethroughPresentation,
			colorScheme: input.colorScheme,
		}),
	};
}
