/**
 * 字色标记导出——"偏移证明优先 + 摘录内文本回退"回归测试（票 08 二次修订）。
 *
 * 背景（真实用户数据复现，小岛经济学 + 后续实测）：
 * 同一章节（同节）内、不同段落的标记也通过「同节过滤」进入候选。
 * ac3a3d8 曾要求这些标记"文本出现在摘录中也不染色"（宁可无色，不可错染）；
 * 但用户实测证明主场景是**反复出现的主题词**（CFI 常解析失败）——该约束使
 * 摘录里的主题词永远无色，笔记同步功能形同虚设。
 *
 * 本文件断言的外部契约（票 08 修订）：
 * - Range 偏移证明优先：标记确实落在划线范围内时按精确偏移染色，**不回退**；
 * - 偏移失败（含标记在划线外/CFI 解析失败/基线失败）时，**摘录内文本回退**：
 *   标记文本在摘录中出现即染色（8/25 成功版语义，用户主场景）；
 * - 两级都失败才跳过（无色纯文本降级，不阻塞导出）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildExcerptDecorationSegments,
	computeFontMarkOffsets,
	computeRangeTextOffsets,
	decorateExcerptText,
	type FontMarkSegment,
} from "../font-mark-decoration";

/** 构造一个最小章节文档，文本节点按【标注位】排布，供 Range 解析与偏移计算。 */
function buildSectionDocument(textNodes: string[]): {
	doc: Document;
	root: HTMLElement;
	textNodeStart(): Map<Node, number>;
} {
	const doc = document.implementation.createHTMLDocument("section");
	const root = doc.createElement("div");
	for (const chunk of textNodes) {
		root.appendChild(doc.createTextNode(chunk));
	}
	doc.body.appendChild(root);
	const textNodeStart = (): Map<Node, number> => {
		const map = new Map<Node, number>();
		const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
		let acc = 0;
		while (walker.nextNode()) {
			map.set(walker.currentNode, acc);
			acc += (walker.currentNode as Text).data.length;
		}
		return map;
	};
	return { doc, root, textNodeStart };
}

function rangeAt(
	doc: Document,
	root: HTMLElement,
	startNodeIndex: number,
	startOffset: number,
	endNodeIndex: number,
	endOffset: number
): Range {
	const textNodes = Array.from(root.childNodes).filter(
		(node): node is Text => node.nodeType === Node.TEXT_NODE
	);
	const range = doc.createRange();
	range.setStart(textNodes[startNodeIndex], startOffset);
	range.setEnd(textNodes[endNodeIndex], endOffset);
	return range;
}

describe("字色导出——标记必须严格落在划线范围内", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("同节不同段落的标记：文本出现在摘录中 → 摘录内文本回退染色（8/25 成功版语义）", () => {
		// 章节文档 = 两段文本：摘录段 + 另一段（标记所在段）。
		const { doc, root } = buildSectionDocument([
			"这是一本别具一格、引人入胜的经济学著作", // 摘录（第一段，划线范围 0..19）
			"如果经济学原理是错的，那么一切都无从谈起", // 另一段：绿色「经济学」标记在此
		]);
		// 划线：第一段 0..19（摘录全文）。
		const highlightRange = rangeAt(doc, root, 0, 0, 0, 19);
		// 标记：第二段中的「经济学」（偏移在当前段 2..5）。
		const markRange = rangeAt(doc, root, 1, 2, 1, 5);

		const excerptText = "这是一本别具一格、引人入胜的经济学著作";
		const marks = [
			{
				cfiRange: "epubcfi(/6/12!/4/14,/1:2,/1:5)", // 另一段的标记
				text: "经济学",
				color: "green",
			},
		];

		const resolved: string[] = [];
		const segments = buildExcerptDecorationSegments({
			text: excerptText,
			highlightCfiRange: "epubcfi(/6/12!/4/8,/1:0,/1:19)",
			marks,
			resolveRange: (cfiRange) => {
				resolved.push(cfiRange);
				if (cfiRange === "epubcfi(/6/12!/4/8,/1:0,/1:19)") {
					return highlightRange;
				}
				return markRange; // 标记 Range 解析成功但不在划线范围内
			},
		});

		// 契约（票 08 二次修订）：标记在划线范围之外 → 偏移无重叠 → 摘录内文本回退；
		// 摘录包含「经济学」（偏移 14..17）→ 染色。
		expect(segments).toEqual([{ start: 14, end: 17, color: "green" }]);
		expect(decorateExcerptText(excerptText, segments)).toBe(
			'这是一本别具一格、引人入胜的<span style="color:#16a34a">经济学</span>著作'
		);
	});

	it("标记确实落在划线范围内时，按 Range 偏移精确染色", () => {
		const { doc, root } = buildSectionDocument(["这是一本别具一格、引人入胜的经济学著作"]);
		const excerptText = "这是一本别具一格、引人入胜的经济学著作";
		const highlightRange = rangeAt(doc, root, 0, 0, 0, 19);
		// 「经济学」= 偏移 13..16。
		const markRange = rangeAt(doc, root, 0, 13, 0, 16);

		const segments = buildExcerptDecorationSegments({
			text: excerptText,
			highlightCfiRange: "epubcfi(/6/12!/4/8,/1:0,/1:19)",
			marks: [{ cfiRange: "epubcfi(/6/12!/4/8,/1:13,/1:16)", text: "经济学", color: "blue" }],
			resolveRange: (cfiRange) => (cfiRange.includes("/1:0") ? highlightRange : markRange),
		});

		expect(segments).toEqual([{ start: 13, end: 16, color: "blue" }]);
	});

	it("标记文本在摘录中重复出现时，只用 Range 精确位置，不回退到首次出现", () => {
		// 摘录内「经济学」出现两次（偏移 0..3 与 9..12）；标记的是第二次。
		const { doc, root } = buildSectionDocument(["经济学书讲经济学，经济学很重要"]);
		const excerptText = "经济学书讲经济学，经济学很重要";
		const highlightRange = rangeAt(doc, root, 0, 0, 0, excerptText.length);
		// 标记第二次出现的「经济学」（offset 9..12）。
		const markRange = rangeAt(doc, root, 0, 9, 0, 12);

		const segments = buildExcerptDecorationSegments({
			text: excerptText,
			highlightCfiRange: "epubcfi(/x,/1:0,/1:15)",
			marks: [{ cfiRange: "epubcfi(/x,/1:9,/1:12)", text: "经济学", color: "red" }],
			resolveRange: (cfiRange) => (cfiRange.includes("/1:0,") ? highlightRange : markRange),
		});

		// 契约：只染第二次出现（9..12），绝不染首次出现（0..3）。
		expect(segments).toEqual([{ start: 9, end: 12, color: "red" }]);
		expect(decorateExcerptText(excerptText, segments)).toBe(
			"经济学书讲经济学，<span style=\"color:#dc2626\">经济学</span>很重要"
		);
	});

	it("computeFontMarkOffsets：越界标记（夹紧后无重叠）返回 null，不做字符串回退服务", () => {
		const { doc, root } = buildSectionDocument([
			"这是摘录范围内的文本内容",
			"越界段落",
		]);
		const highlightRange = rangeAt(doc, root, 0, 0, 0, 12); // 第一段 0..12
		const markRange = rangeAt(doc, root, 1, 0, 1, 4); // 第二段（越界）

		expect(computeFontMarkOffsets(highlightRange, markRange, 12)).toBeNull();
	});

	it("decorateExcerptText 对重叠切段按起点优先裁剪，不产生嵌套 span", () => {
		const segments: FontMarkSegment[] = [
			{ start: 4, end: 5, color: "blue" },
			{ start: 4, end: 6, color: "red" },
		];
		const output = decorateExcerptText("这是一本别具一格的书", segments);
		expect(output).toBe(
			"这是一本<span style=\"color:#2563eb\">别</span><span style=\"color:#dc2626\">具</span>一格的书"
		);
	});

	it("computeRangeTextOffsets：文本节点拼接坐标正确，跨节点 Range 正确", () => {
		// 段内文本 "ab" + "cd"（两个文本节点拼接）。
		const doc = document.implementation.createHTMLDocument("section");
		const root = doc.createElement("div");
		root.appendChild(doc.createTextNode("ab"));
		root.appendChild(doc.createTextNode("cd"));
		doc.body.appendChild(root);
		const textNodes = Array.from(root.childNodes).filter(
			(node): node is Text => node.nodeType === Node.TEXT_NODE
		);

		const single = doc.createRange();
		single.setStart(textNodes[0], 1);
		single.setEnd(textNodes[0], 2);
		expect(computeRangeTextOffsets(doc, single)).toEqual({ start: 1, end: 2 });

		const cross = doc.createRange();
		cross.setStart(textNodes[0], 1);
		cross.setEnd(textNodes[1], 1);
		expect(computeRangeTextOffsets(doc, cross)).toEqual({ start: 1, end: 3 });
	});
});