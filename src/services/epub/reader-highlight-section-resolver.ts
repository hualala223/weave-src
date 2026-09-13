import { perfBegin, perfEnd, perfTick } from "../../utils/perf-probe";
import type { ReaderHighlight } from "./reader-engine-types";

export interface HighlightSectionResolverPort {
	getSectionIndexForCfi(cfiRange: string): number | null;
	resolveRangeInLoadedSection(
		cfiRange: string,
		frameDocument: Document,
		sectionIndex: number,
		textHint?: string
	): Range | null;
}

export interface VisibleHighlightFrame {
	index: number;
	frameDocument: Document;
}

export function orderVisibleHighlightFrames<T extends VisibleHighlightFrame>(
	frames: T[],
	preferredChapter: number | null | undefined
): T[] {
	if (typeof preferredChapter !== "number") {
		return frames;
	}
	return [
		...frames.filter((frame) => frame.index === preferredChapter),
		...frames.filter((frame) => frame.index !== preferredChapter),
	];
}

export function resolveHighlightSectionIndexForView(
	highlight: ReaderHighlight,
	visibleFrames: VisibleHighlightFrame[],
	port: HighlightSectionResolverPort
): number | null {
	const probeStart = perfBegin();
	perfTick("resolveSectionIndex.calls");
	const textHint = String(highlight.text || "").trim();
	const visibleIndexes = new Set(visibleFrames.map((frame) => frame.index));

	const direct = port.getSectionIndexForCfi(highlight.cfiRange);
	if (direct !== null && visibleIndexes.has(direct)) {
		perfEnd("resolveSectionIndex", probeStart, { extra: { path: "direct-visible" } });
		return direct;
	}

	if (!textHint) {
		perfEnd("resolveSectionIndex", probeStart, { extra: { path: "no-hint" } });
		return direct !== null && visibleIndexes.has(direct) ? direct : null;
	}

	// 快路径：CFI 已解析出明确章节、且该章节不在可见范围内时，
	// 到其他可见章节里做全文搜索是注定失败的——每次都要把整章正文
	// 归一化后重扫一遍，N 条划线 × V 个可见帧就是这么慢下来的。
	// 仅当记录里自带的 chapterIndex 指向某个可见章节时才保留兜底：
	// 那说明 CFI 可能过时（书籍重新导入/章节顺序变化），需要靠文本纠回。
	if (direct !== null && !visibleIndexes.has(direct)) {
		const chapterHintVisible =
			typeof highlight.chapterIndex === "number" &&
			Number.isFinite(highlight.chapterIndex) &&
			visibleIndexes.has(highlight.chapterIndex);
		if (!chapterHintVisible) {
			perfTick("resolveSectionIndex.skippedByResolvedSection");
			perfEnd("resolveSectionIndex", probeStart, { extra: { path: "skip-other-section" } });
			return null;
		}
	}

	const preferredChapter =
		typeof highlight.chapterIndex === "number" && Number.isFinite(highlight.chapterIndex)
			? highlight.chapterIndex
			: direct;

	perfTick("resolveSectionIndex.fallbackLoop");
	for (const frame of orderVisibleHighlightFrames(visibleFrames, preferredChapter)) {
		const range = port.resolveRangeInLoadedSection(
			highlight.cfiRange,
			frame.frameDocument,
			frame.index,
			textHint
		);
		if (range) {
			perfTick("resolveSectionIndex.fallbackHit");
			perfEnd("resolveSectionIndex", probeStart, { extra: { path: "fallback-hit" } });
			return frame.index;
		}
	}

	perfEnd("resolveSectionIndex", probeStart, { extra: { path: "fallback-miss" } });
	return direct !== null && visibleIndexes.has(direct) ? direct : null;
}
