import { describe, expect, it } from "vitest";
import {
	buildFontMarkHitCandidates,
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

describe("buildFontMarkHitCandidates（点击候选构建：锚失败时短词兜底同样可用）", () => {
	const MARK_CFI = "epubcfi(/6/4!/4/2,/1:3,/1:6)";

	function buildSectionResolver(mapping: Record<string, number | null>) {
		return (cfiRange: string) => mapping[cfiRange] ?? null;
	}

	it("锚解析失败但短词节内唯一出现 → 该标记进入候选（兜底找回 Range）", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => null, // 模拟 CFI 锚解析失败
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range.toString()).toBe("经济学");
		expect(candidates[0].mark.cfiRange).toBe(MARK_CFI);
	});

	it("锚解析失败 + 短词出现多次：书内宽回退按首个出现进候选（用户可点选）", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => null,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range.toString()).toBe("经济学");
	});

	it("锚解析失败 + ≥4 字词：书内宽回退同样进候选（不限词长）", () => {
		const doc = buildDoc("<p>这是一句足够长的引述文字</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "这是一句足够长", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => null,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range.toString()).toBe("这是一句足够长");
	});

	it("异节标记（节号不同）不参与候选，即使其文本在本节唯一出现", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 1 }), // 异节
			resolveRangeInDocument: (cfi, textHint) =>
				textHint ? rangeForParagraph(doc, 0, 4, 7) : null,
		});
		expect(candidates).toHaveLength(0);
	});

	it("节号解析失败（无法证明归属）不参与候选", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: null }),
			resolveRangeInDocument: () => null,
		});
		expect(candidates).toHaveLength(0);
	});

	it("锚解析成功 → 候选直接用解析出的 Range", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const range = rangeForParagraph(doc, 0, 4, 7);
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => range,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range).toBe(range);
	});

	it("解析器抛异常 → 视为解析失败：短词唯一出现仍兜底进候选（与渲染路径一致），不冒泡", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => {
				throw new Error("boom");
			},
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range.toString()).toBe("经济学");
	});

	it("解析器抛异常 + 短词多次出现：视为解析失败，宽回退按首个出现进候选，不冒泡", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const candidates = buildFontMarkHitCandidates({
			doc,
			frameIndex: 0,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveSectionIndex: buildSectionResolver({ [MARK_CFI]: 0 }),
			resolveRangeInDocument: () => {
				throw new Error("boom");
			},
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0].range.toString()).toBe("经济学");
	});
});
