/**
 * 字色标记导出——真实图书选区回归（根因 ① 修复前的 RED 用例）。
 *
 * 背景（用户实测复现）：
 * 真实书里划线选区的 `selection.toString().trim()`（SelectionToolbar.svelte:532）
 * 与「文本节点拼接坐标」存在两类系统性偏差：
 *   1. 块边界：选区跨越 <p>/<div>/<li> 等块级元素时，toString 会在块间插入 "\n"，
 *      拼接坐标没有分隔符 → 长度守卫（computeFontMarkOffsets 的 excerptTextLength 校验）必挂；
 *   2. 选区边缘空白：拖选常包含行首/行尾空白，.trim() 砍掉两端，
 *      拼接坐标含这些空白 → 长度守卫必挂。
 * 票 07（ac3a3d8）删除字符串回退后，这两类偏差导致「记号在划线内」的真实标记
 * 被整体跳过、摘录以纯文本导出——笔记文档里关键字词不再着色。
 *
 * 本文件断言修复后的外部契约（不改变「严格包含性」语义）：
 * - 块感知比较：跨段划线（摘录文本含块间 "\n"）时，落在划线内的标记仍能按
 *   Range 偏移精确换算（摘录 = 按块边界插入 "\n" 后的规范化文本）；
 * - 边缘空白容差：选区含首尾空白（被 trim）时，标记偏移按 trim 后的摘录对齐；
 * - 仍不误染：标记 Range 在划线之外时，其文本在摘录中出现也不产生切段。
 */

import { describe, expect, it } from "vitest";
import { buildExcerptDecorationSegments, computeFontMarkOffsets } from "../font-mark-decoration";

function buildDoc(html: string): Document {
	return new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
}

/** 段落级 Range：第 paragraphIndex 个 <p> 的文本节点上 [start, end)。 */
function rangeForParagraph(doc: Document, paragraphIndex: number, start: number, end: number): Range {
	const paragraphs = doc.body.querySelectorAll("p");
	const paragraph = paragraphs[paragraphIndex];
	if (!paragraph || !paragraph.firstChild) {
		throw new Error(`段落 ${paragraphIndex} 不存在或没有文本节点`);
	}
	const range = doc.createRange();
	range.setStart(paragraph.firstChild, start);
	range.setEnd(paragraph.firstChild, end);
	return range;
}

describe("computeFontMarkOffsets：块感知 + 边缘空白容差（真实图书选区回归）", () => {
	it("跨段划线：摘录文本含块间 \\n（toString 语义）时，落在划线内的标记仍按文档顺序换算", () => {
		const doc = buildDoc("<p>第一段有重点词</p><p>第二段继续</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 0);
		highlight.setEnd(paragraphs[1].firstChild!, 4);

		// 浏览器 selection.toString() 语义：块级元素边界插入 "\n"。
		const blockAwareExcerpt = "第一段有重点词\n第二段继";
		// 标记「重点词」落在第一段内（块感知文本中偏移 3..6）。
		const mark = rangeForParagraph(doc, 0, 3, 6);

		const offsets = computeFontMarkOffsets(highlight, mark, blockAwareExcerpt.length);
		expect(offsets).toEqual({ start: 3, end: 6 });
	});

	it("选区包含首尾空白（被 trim）：标记偏移按 trim 后的摘录对齐", () => {
		const doc = buildDoc("<p>  今天天气真好啊  </p>");
		// 用户拖选包含首尾空白，selection.toString().trim() 后摘录为纯文本。
		const trimmedExcerpt = "今天天气真好啊";
		const highlight = rangeForParagraph(doc, 0, 0, 11); // 含两端空白
		const mark = rangeForParagraph(doc, 0, 4, 6); // 「天气」（节点内 4..6）

		const offsets = computeFontMarkOffsets(highlight, mark, trimmedExcerpt.length);
		// trim 去掉 2 个前导空白 → 「天气」在 trim 后摘录的 2..4。
		expect(offsets).toEqual({ start: 2, end: 4 });
	});

	it("跨段 + 段内空格同时存在：偏移对齐块感知文本，段内空格不参与首尾 trim", () => {
		const doc = buildDoc("<p>第一段有重点词 </p><p>第二段继</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 0);
		highlight.setEnd(paragraphs[1].firstChild!, 3);

		// 块感知文本 = "第一段有重点词 \n第二段"（p0 尾随空格保留在段内，\n 是块分隔）。
		const excerpt = "第一段有重点词 \n第二段";
		const mark = rangeForParagraph(doc, 0, 4, 7); // 「重点词」（含段内前导：第0一1段2有3）

		const offsets = computeFontMarkOffsets(highlight, mark, excerpt.length);
		expect(offsets).toEqual({ start: 4, end: 7 });
	});

	it("偏差未超过容差（内容长度仍不一致）时返回 null，保持保守降级", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const highlight = rangeForParagraph(doc, 0, 0, 7);
		const mark = rangeForParagraph(doc, 0, 2, 4);
		// 摘录长度与划线内容长度差异超过 trim/块分隔容差 → 不可信，返回 null。
		expect(computeFontMarkOffsets(highlight, mark, 999)).toBeNull();
	});

	it("跨三个段落：中间段标记按块感知坐标换算，不回退到字符串查找", () => {
		const doc = buildDoc("<p>第一段</p><p>第二段</p><p>第三段</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 0);
		highlight.setEnd(paragraphs[2].firstChild!, 3);
		const mark = rangeForParagraph(doc, 1, 0, 2); // 「第二」前两字

		const excerpt = "第一段\n第二段\n第三段";
		const offsets = computeFontMarkOffsets(highlight, mark, excerpt.length);
		// 第一段 0..3，"\n" 占 3，第二段从 4 起 → 「第二」= 4..6。
		expect(offsets).toEqual({ start: 4, end: 6 });
	});
});

describe("buildExcerptDecorationSegments：真实选区回归下的导出编排", () => {
	it("跨段摘录 + 落在划线内的标记：Range 证明包含 → 精确染色切段", () => {
		const doc = buildDoc("<p>第一段有重点词</p><p>第二段继续</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 0);
		highlight.setEnd(paragraphs[1].firstChild!, 4);
		const mark = rangeForParagraph(doc, 0, 3, 6);

		const excerpt = "第一段有重点词\n第二段继";
		const segments = buildExcerptDecorationSegments({
			text: excerpt,
			highlightCfiRange: "epubcfi(/6/12!/4/8,/1:0,/1:11)",
			marks: [{ cfiRange: "epubcfi(/6/12!/4/8,/1:3,/1:6)", text: "重点词", color: "red" }],
			resolveRange: (cfiRange: string) => {
				if (cfiRange.includes("/1:0,")) return highlight;
				return mark;
			},
		});

		expect(segments).toEqual([{ start: 3, end: 6, color: "red" }]);
	});

	it("同节不同段落的标记：文本出现在摘录中也不产生切段（不误染不变式）", () => {
		const doc = buildDoc("<p>这是摘录段</p><p>经济学原理在另一段</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = rangeForParagraph(doc, 0, 0, 5);
		const markRange = rangeForParagraph(doc, 1, 0, 3); // 「经济学」在第二段

		const excerpt = "这是摘录段";
		const segments = buildExcerptDecorationSegments({
			text: excerpt,
			highlightCfiRange: "epubcfi(/6/12!/4/8,/1:0,/1:6)",
			marks: [{ cfiRange: "epubcfi(/6/12!/4/14,/1:0,/1:3)", text: "经济学", color: "green" }],
			resolveRange: (cfiRange: string) =>
				cfiRange.includes("/4/8") ? highlight : markRange,
		});

		expect(segments).toEqual([]);
	});
});