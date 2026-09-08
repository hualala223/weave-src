import * as EpubCfi from "./epub-cfi";
import { getCfiParentPath } from "./epub-cfi";
import type { ReaderParagraph } from "./reader-engine-types";

export type ExcerptParagraphMatchStatus = "matched" | "text-miss" | "invalid";

export interface ExcerptParagraphHighlight {
	start: number;
	end: number;
}

export interface ExcerptParagraphMatch {
	status: ExcerptParagraphMatchStatus;
	paragraph: ReaderParagraph | null;
	/** 划线覆盖区间（paragraph.text 上的原始偏移）；无法计算时为 null（如纯 CFI 命中）。 */
	highlight: ExcerptParagraphHighlight | null;
}

export interface ExcerptParagraphResolverInput {
	excerptCfi: string;
	excerptText: string;
	paragraphs: ReaderParagraph[];
}

/**
 * 段落级归属匹配所需的最短片段长度：低于它的高亮匹配视为噪声。
 * 中文关键词式划线常见 3~5 字，阈值不能过高。
 */
const MIN_SEGMENT_LENGTH = 3;

/** 跨段落划线的首/尾匹配长度：与段首/段尾比对的归一化字符数下限。 */
const CROSS_PARAGRAPH_HEAD_TAIL_LENGTH = 4;

function normalizeWhitespace(text: string): string {
	return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * 归一化文本并保留到原文的索引映射：
 * map[i] = 归一化文本第 i 个字符在原文中的偏移。
 */
function buildNormalizedMapping(raw: string): { normalized: string; map: number[] } {
	const map: number[] = [];
	let normalized = "";
	let pendingSpace = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (/\s/.test(ch)) {
			pendingSpace = normalized.length > 0;
			continue;
		}
		if (pendingSpace) {
			normalized += " ";
			map.push(i);
			pendingSpace = false;
		}
		normalized += ch;
		map.push(i);
	}
	return { normalized, map };
}

/** 划线片段切分：按句读断开，用于跨段落划线只取落在本段内的部分。 */
function splitIntoSegments(normalizedText: string): string[] {
	return normalizedText
		.split(/[。！？!?；;\n]+/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length >= MIN_SEGMENT_LENGTH);
}

interface SegmentHighlight {
	start: number;
	end: number;
	/** 命中片段的归一化长度，用于跨段落挑选"落在本段内最长的部分"。 */
	length: number;
}

function findHighlightInParagraph(
	paragraphText: string,
	excerptText: string
): SegmentHighlight | null {
	const paragraphNorm = buildNormalizedMapping(paragraphText);
	if (!paragraphNorm.normalized) {
		return null;
	}
	const excerptNorm = normalizeWhitespace(excerptText);
	if (!excerptNorm) {
		return null;
	}

	let index = paragraphNorm.normalized.indexOf(excerptNorm);
	if (index !== -1) {
		const rawStart = paragraphNorm.map[index];
		const rawEnd = paragraphNorm.map[index + excerptNorm.length - 1] + 1;
		return { start: rawStart, end: rawEnd, length: excerptNorm.length };
	}

	// 跨段落划线：取落在该段内的最长片段。
	let best: SegmentHighlight | null = null;
	for (const segment of splitIntoSegments(excerptNorm)) {
		index = paragraphNorm.normalized.indexOf(segment);
		if (index === -1) {
			continue;
		}
		if (!best || segment.length > best.length) {
			best = {
				start: paragraphNorm.map[index],
				end: paragraphNorm.map[index + segment.length - 1] + 1,
				length: segment.length,
			};
		}
	}
	return best;
}

/**
 * 跨段落划线的首尾归属（句读片段都没命中时的最后文本手段）：
 * 摘录的第一个片段贴着某段的**段尾**（起点段），或最后一个片段贴着某段的**段首**（终点段）。
 * 跨段切分允许逗号级（段落可在任何句读处断开）；不足两段时按中点切成两半。
 */
function findCrossParagraphHighlight(
	paragraphText: string,
	excerptNorm: string
): ExcerptParagraphHighlight | null {
	const paragraphNorm = buildNormalizedMapping(paragraphText);
	if (!paragraphNorm.normalized || excerptNorm.length < CROSS_PARAGRAPH_HEAD_TAIL_LENGTH * 2) {
		return null;
	}

	let segments = excerptNorm
		.split(/[。！？!?；;，,\n]+/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length >= CROSS_PARAGRAPH_HEAD_TAIL_LENGTH);
	if (segments.length < 2) {
		const mid = Math.floor(excerptNorm.length / 2);
		const firstHalf = excerptNorm.slice(0, mid);
		const secondHalf = excerptNorm.slice(mid);
		if (
			firstHalf.length < CROSS_PARAGRAPH_HEAD_TAIL_LENGTH ||
			secondHalf.length < CROSS_PARAGRAPH_HEAD_TAIL_LENGTH
		) {
			return null;
		}
		segments = [firstHalf, secondHalf];
	}

	const head = segments[0];
	if (paragraphNorm.normalized.endsWith(head)) {
		const startIndex = paragraphNorm.normalized.length - head.length;
		return {
			start: paragraphNorm.map[startIndex],
			end: paragraphNorm.map[paragraphNorm.normalized.length - 1] + 1,
		};
	}

	const tail = segments[segments.length - 1];
	if (paragraphNorm.normalized.startsWith(tail)) {
		return {
			start: paragraphNorm.map[0],
			end: paragraphNorm.map[tail.length - 1] + 1,
		};
	}
	return null;
}

function cfiParentKey(cfi: string): string | null {
	try {
		return JSON.stringify(getCfiParentPath(EpubCfi.parse(cfi)));
	} catch {
		return null;
	}
}

/**
 * 在章节段落列表中解析摘录所在段落与划线区间。
 * 匹配顺序：归一化文本全文包含 → 句读片段（跨段落划线取本段部分）→
 * 段首/段尾首尾归属（摘录起点/终点跨段）→ CFI 段落级父路径。
 */
export function resolveExcerptParagraph(
	input: ExcerptParagraphResolverInput
): ExcerptParagraphMatch {
	const paragraphs = Array.isArray(input?.paragraphs) ? input.paragraphs : [];
	if (!paragraphs.length) {
		return { status: "invalid", paragraph: null, highlight: null };
	}

	const excerptText = normalizeWhitespace(input?.excerptText);
	const excerptCfi = String(input?.excerptCfi || "").trim();
	if (!excerptText && !excerptCfi) {
		return { status: "invalid", paragraph: null, highlight: null };
	}

	// 1) 全文 / 片段文本包含；跨段落在多个段命中时取片段最长的那段。
	if (excerptText) {
		let partial: {
			paragraph: ReaderParagraph;
			highlight: ExcerptParagraphHighlight;
			length: number;
		} | null = null;
		for (const paragraph of paragraphs) {
			const match = findHighlightInParagraph(paragraph.text, excerptText);
			if (!match) {
				continue;
			}
			if (match.length === normalizeWhitespace(paragraph.text).length || normalizeWhitespace(paragraph.text).includes(excerptText)) {
				return { status: "matched", paragraph, highlight: { start: match.start, end: match.end } };
			}
			if (!partial || match.length > partial.length) {
				partial = { paragraph, highlight: { start: match.start, end: match.end }, length: match.length };
			}
		}
		if (partial) {
			return { status: "matched", paragraph: partial.paragraph, highlight: partial.highlight };
		}

		// 2) 摘录起点贴着某段段尾（跨段起点）或终点贴着某段段首（跨段终点）。
		for (const paragraph of paragraphs) {
			const highlight = findCrossParagraphHighlight(paragraph.text, excerptText);
			if (highlight) {
				return { status: "matched", paragraph, highlight };
			}
		}
	}

	// 3) CFI 段落级父路径归属（文本对不上但定位仍可归属时，降级为整段无高亮）。
	if (excerptCfi) {
		const excerptParent = cfiParentKey(excerptCfi);
		if (excerptParent) {
			for (const paragraph of paragraphs) {
				if (cfiParentKey(paragraph.cfiRange) === excerptParent) {
					return { status: "matched", paragraph, highlight: null };
				}
			}
		}
	}

	return { status: "text-miss", paragraph: null, highlight: null };
}
