import { describe, expect, it } from "vitest";
import {
	caretIsInsideFontMarkRange,
	findFontMarkAtCaret,
	type FontMarkHitCandidate,
} from "../font-mark-hit-test";
import type { ReaderFontMark } from "../reader-engine-types";

function buildDoc(html: string): Document {
	return new DOMParser().parseFromString(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
		"text/html",
	);
}

/** 第 paragraphIndex 个段落的文本节点（缺失即抛错，避免非空断言）。 */
function textNodeOfParagraph(doc: Document, paragraphIndex: number): Node {
	const paragraph = doc.body.querySelectorAll("p")[paragraphIndex];
	const firstChild = paragraph?.firstChild;
	if (!firstChild) {
		throw new Error(`段落 ${paragraphIndex} 不存在或没有文本节点`);
	}
	return firstChild;
}

/** 在第 paragraphIndex 个段落的文本上创建 [start, end) 字符范围的 Range。 */
function rangeForParagraph(
	doc: Document,
	paragraphIndex: number,
	start: number,
	end: number,
): Range {
	const paragraph = doc.body.querySelectorAll("p")[paragraphIndex];
	if (!paragraph?.firstChild) {
		throw new Error(`段落 ${paragraphIndex} 不存在或没有文本节点`);
	}
	const range = doc.createRange();
	range.setStart(paragraph.firstChild, start);
	range.setEnd(paragraph.firstChild, end);
	return range;
}

function buildMark(overrides: Partial<ReaderFontMark> = {}): ReaderFontMark {
	return { cfiRange: "epubcfi(/6/4)", color: "red", ...overrides };
}

describe("caretIsInsideFontMarkRange（caret 点是否落在已解析标记 Range 内）", () => {
	it("标记词内部偏移命中", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const range = rangeForParagraph(doc, 0, 2, 4);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 3 }, range)).toBe(true);
	});

	it("边界语义与既有划线命中一致（isPointInRange：终点边界按 DOM 规范算在内）", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const range = rangeForParagraph(doc, 0, 2, 4);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 2 }, range)).toBe(true);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 4 }, range)).toBe(true);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 5 }, range)).toBe(false);
	});

	it("标记词前后的偏移不命中", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const range = rangeForParagraph(doc, 0, 2, 4);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 0 }, range)).toBe(false);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 6 }, range)).toBe(false);
	});

	it("其他段落的 caret 不命中（不同容器）", () => {
		const doc = buildDoc("<p>第一段文字</p><p>第二段文字</p>");
		const otherParagraphText = textNodeOfParagraph(doc, 1);
		const range = rangeForParagraph(doc, 0, 0, 3);
		expect(caretIsInsideFontMarkRange({ node: otherParagraphText, offset: 1 }, range)).toBe(false);
	});

	it("跨文档的候选 Range 判定为不命中而非抛异常", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const otherDoc = buildDoc("<p>另一份章节文档</p>");
		const text = textNodeOfParagraph(doc, 0);
		const foreignRange = rangeForParagraph(otherDoc, 0, 0, 3);
		expect(caretIsInsideFontMarkRange({ node: text, offset: 1 }, foreignRange)).toBe(false);
	});
});

describe("findFontMarkAtCaret（候选标记筛选）", () => {
	it("返回唯一包含 caret 的候选并原样携带 mark 与 range", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const hitRange = rangeForParagraph(doc, 0, 2, 4);
		const missRange = rangeForParagraph(doc, 0, 5, 7);
		const hitMark = buildMark({ cfiRange: "epubcfi(hit)", color: "gold" });
		const missMark = buildMark({ cfiRange: "epubcfi(miss)", color: "blue" });
		const candidates: FontMarkHitCandidate[] = [
			{ mark: missMark, range: missRange },
			{ mark: hitMark, range: hitRange },
		];

		const hit = findFontMarkAtCaret({ node: text, offset: 3 }, candidates);
		expect(hit?.mark).toBe(hitMark);
		expect(hit?.range).toBe(hitRange);
	});

	it("重叠标记时取范围最小者（最精确的词级命中）", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const wideRange = rangeForParagraph(doc, 0, 0, 7);
		const narrowRange = rangeForParagraph(doc, 0, 2, 4);
		const wideMark = buildMark({ cfiRange: "epubcfi(wide)" });
		const narrowMark = buildMark({ cfiRange: "epubcfi(narrow)", color: "purple" });

		const hit = findFontMarkAtCaret({ node: text, offset: 3 }, [
			{ mark: wideMark, range: wideRange },
			{ mark: narrowMark, range: narrowRange },
		]);
		expect(hit?.mark).toBe(narrowMark);
	});

	it("没有任何候选包含 caret 时返回 null", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const text = textNodeOfParagraph(doc, 0);
		const candidates: FontMarkHitCandidate[] = [
			{ mark: buildMark(), range: rangeForParagraph(doc, 0, 2, 4) },
		];
		expect(findFontMarkAtCaret({ node: text, offset: 6 }, candidates)).toBeNull();
		expect(findFontMarkAtCaret({ node: text, offset: 3 }, [])).toBeNull();
	});
});
