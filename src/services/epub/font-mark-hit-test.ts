/**
 * 字色标记（Font mark）点击命中检测纯函数模块。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md。
 * 书内渲染走 CSS Custom Highlight——内容 DOM 没有可接收点击的着色元素，
 * 命中检测只能把点击点映射为 caret 位置后与「已解析的标记 Range」做包含判定。
 * 本模块只做判定；caret 提取、CFI→Range 解析由 FoliateReaderService 注入完成。
 *
 * 任何失败都不抛异常：命中判定失败一律视为未命中，绝不阻塞翻页等默认交互。
 */

import type { ReaderFontMark } from "./reader-engine-types";

/** 已解析出章节文档 Range 的字色标记候选（服务侧解析，本模块只做筛选）。 */
export interface FontMarkHitCandidate {
	mark: ReaderFontMark;
	range: Range;
}

export interface CaretPosition {
	node: Node;
	offset: number;
}

/**
 * caret 点是否落在标记 Range 内。
 * 边界语义与既有划线命中一致（isPointInRange）：起点含、终点不含；
 * isPointInRange 不可用时退化为边界比较，跨文档等异常一律按未命中处理。
 */
export function caretIsInsideFontMarkRange(caret: CaretPosition, range: Range): boolean {
	try {
		return range.isPointInRange(caret.node, caret.offset);
	} catch {
		// isPointInRange 对跨文档/异常输入会直接抛错；退回边界比较再兜一层。
	}
	try {
		const doc = caret.node.ownerDocument;
		if (!doc) {
			return false;
		}
		const caretRange = doc.createRange();
		caretRange.setStart(caret.node, caret.offset);
		caretRange.collapse(true);
		return (
			range.compareBoundaryPoints(Range.START_TO_END, caretRange) <= 0 &&
			range.compareBoundaryPoints(Range.END_TO_START, caretRange) >= 0
		);
	} catch {
		return false;
	}
}

/** 标记 Range 覆盖的文本长度（重叠时取更小者＝更精确的词级命中的度量）。 */
function getRangeTextLength(range: Range): number {
	try {
		return range.toString().length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * 从候选中找出包含 caret 的标记；多个重叠命中时取范围最小者。
 * 无命中返回 null——调用方据此放行点击的默认行为（如翻页）。
 */
export function findFontMarkAtCaret(
	caret: CaretPosition,
	candidates: readonly FontMarkHitCandidate[]
): FontMarkHitCandidate | null {
	let best: FontMarkHitCandidate | null = null;
	let bestLength = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		if (!candidate?.range || !candidate.mark) {
			continue;
		}
		if (!caretIsInsideFontMarkRange(caret, candidate.range)) {
			continue;
		}
		const length = getRangeTextLength(candidate.range);
		if (length < bestLength) {
			best = candidate;
			bestLength = length;
		}
	}
	return best;
}
