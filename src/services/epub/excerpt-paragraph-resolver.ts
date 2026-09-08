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

/** 段落级归属匹配所需的最短片段长度：低于它的高亮匹配视为噪声。 */
const MIN_SEGMENT_LENGTH = 6;

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

function findHighlightInParagraph(
	paragraphText: string,
	excerptText: string
): ExcerptParagraphHighlight | null {
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
		return { start: rawStart, end: rawEnd };
	}

	// 跨段落划线：取落在该段内的最长片段。
	let best: { start: number; end: number; length: number } | null = null;
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
	if (best) {
		return { start: best.start, end: best.end };
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
 * 匹配顺序：归一化文本全文包含 → 句读片段（跨段落划线取本段部分）→ CFI 段落级父路径。
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

	// 1) 全文 / 片段文本包含。
	if (excerptText) {
		let partial: { paragraph: ReaderParagraph; highlight: ExcerptParagraphHighlight } | null = null;
		for (const paragraph of paragraphs) {
			const highlight = findHighlightInParagraph(paragraph.text, excerptText);
			if (!highlight) {
				continue;
			}
			const isFullMatch =
				normalizeWhitespace(paragraph.text).includes(excerptText) && highlight !== null;
			if (isFullMatch) {
				return { status: "matched", paragraph, highlight };
			}
			if (!partial) {
				partial = { paragraph, highlight };
			}
		}
		if (partial) {
			return { status: "matched", paragraph: partial.paragraph, highlight: partial.highlight };
		}
	}

	// 2) CFI 段落级父路径归属（文本对不上但定位仍可归属时，降级为整段无高亮）。
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
