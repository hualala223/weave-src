import { describe, expect, it } from "vitest";
import {
	FONT_MARK_COLOR_TOKENS,
	FONT_MARK_EXPORT_HEX,
	computeFontMarkOffsets,
	decorateExcerptText,
	findFontMarkByText,
	isFontMarkColorToken,
	resolveFontMarkBookTint,
	type FontMarkSegment,
} from "../font-mark-decoration";

function buildDoc(html: string): Document {
	const parsed = new DOMParser().parseFromString(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
		"text/html",
	);
	return parsed;
}

/** 在第 containerIndex 个段落的文本上创建 [start, end) 字符范围的 Range。 */
function rangeForParagraph(
	doc: Document,
	paragraphIndex: number,
	start: number,
	end: number,
): Range {
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

describe("字色装饰模块：颜色 token 与导出映射", () => {
	it("五个颜色 token 固定为红/金/蓝/绿/紫", () => {
		expect([...FONT_MARK_COLOR_TOKENS]).toEqual(["red", "gold", "blue", "green", "purple"]);
	});

	it("导出到 MD 的固定 hex 遵循规格契约（黄档为深金保证白底可读）", () => {
		expect(FONT_MARK_EXPORT_HEX).toEqual({
			red: "#dc2626",
			gold: "#b45309",
			blue: "#2563eb",
			green: "#16a34a",
			purple: "#9333ea",
		});
	});

	it("书内渲染按明暗主题提供色值，金色档浅色主题用深金、深色主题用亮金", () => {
		expect(resolveFontMarkBookTint("gold", "light")).toBe("#b45309");
		expect(resolveFontMarkBookTint("gold", "dark")).toBe("#fbbf24");
	});
});

describe("decorateExcerptText", () => {
	it("单一切段包成仅含 color 的行内 span，使用导出 hex", () => {
		const decorated = decorateExcerptText("今天天气真好啊", [
			{ start: 2, end: 4, color: "red" },
		]);
		expect(decorated).toBe('今天<span style="color:#dc2626">天气</span>真好啊');
	});

	it("同一句多色各留各色、按原文顺序排列", () => {
		const decorated = decorateExcerptText("今天天气真好啊", [
			{ start: 0, end: 2, color: "blue" },
			{ start: 4, end: 5, color: "green" },
		]);
		expect(decorated).toBe(
			'<span style="color:#2563eb">今天</span>天气<span style="color:#16a34a">真</span>好啊',
		);
	});

	it("跨行文本照常装饰（不感知换行）", () => {
		const decorated = decorateExcerptText("第一行重点\n第二行", [
			{ start: 3, end: 5, color: "purple" },
		]);
		expect(decorated).toBe('第一行<span style="color:#9333ea">重点</span>\n第二行');
	});

	it("切段越界时裁剪到文本长度；空切段被丢弃", () => {
		const decorated = decorateExcerptText("短文", [
			{ start: 1, end: 99, color: "red" },
			{ start: 3, end: 8, color: "blue" },
		]);
		expect(decorated).toBe('短<span style="color:#dc2626">文</span>');
	});

	it("切段相互重叠时按起点优先裁剪，不产生嵌套 span", () => {
		const decorated = decorateExcerptText("abcdef", [
			{ start: 2, end: 6, color: "blue" },
			{ start: 0, end: 4, color: "red" },
		]);
		expect(decorated).toBe(
			'<span style="color:#dc2626">abcd</span><span style="color:#2563eb">ef</span>',
		);
	});

	it("无有效切段时原样返回纯文本", () => {
		expect(decorateExcerptText("纯文本", [])).toBe("纯文本");
	});
});

describe("computeFontMarkOffsets（DOM Range 偏移计算）", () => {
	it("同段落内的标记换算为摘录文本内的字符偏移", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const highlight = rangeForParagraph(doc, 0, 0, 7);
		const mark = rangeForParagraph(doc, 0, 2, 4);

		expect(computeFontMarkOffsets(highlight, mark, 7)).toEqual({ start: 2, end: 4 });
	});

	it("标记超出划线范围的部分被裁剪（两侧越界）", () => {
		const doc = buildDoc("<p>零一二三四五六七八九</p>");
		const highlight = rangeForParagraph(doc, 0, 2, 6);
		const mark = rangeForParagraph(doc, 0, 0, 9);

		expect(computeFontMarkOffsets(highlight, mark, 4)).toEqual({ start: 0, end: 4 });
	});

	it("标记与划线无重叠时返回 null", () => {
		const doc = buildDoc("<p>零一二三四五六七八九</p>");
		const highlight = rangeForParagraph(doc, 0, 0, 3);
		const mark = rangeForParagraph(doc, 0, 5, 8);

		expect(computeFontMarkOffsets(highlight, mark, 3)).toBeNull();
	});

	it("摘录长度与划线范围文本长度不一致（selection 文本差异防护）时返回 null", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const highlight = rangeForParagraph(doc, 0, 0, 7);
		const mark = rangeForParagraph(doc, 0, 2, 4);

		expect(computeFontMarkOffsets(highlight, mark, 999)).toBeNull();
	});

	it("跨元素边界（标记横跨两个段落）只保留落在划线范围内的部分", () => {
		const doc = buildDoc("<p>第一段落文字</p><p>第二段落文字</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 2);
		highlight.setEnd(paragraphs[1].firstChild!, 4);
		const mark = doc.createRange();
		mark.setStart(paragraphs[0].firstChild!, 4);
		mark.setEnd(paragraphs[1].firstChild!, 6);

		// 摘录按文本节点拼接长度计（段落一尾部 4 字 + 段落二前 4 字）；
		// 标记越出划线终点的部分被裁剪。
		expect(computeFontMarkOffsets(highlight, mark, 8)).toEqual({ start: 2, end: 8 });
	});
});

describe("findFontMarkByText（字符串查找回退）", () => {
	it("命中首个出现位置并返回区间", () => {
		expect(findFontMarkByText("今天天气真好啊", "天气")).toEqual({ start: 2, end: 4 });
	});

	it("找不到或标记文本为空时返回 null", () => {
		expect(findFontMarkByText("今天天气真好啊", "下雨")).toBeNull();
		expect(findFontMarkByText("今天天气真好啊", "   ")).toBeNull();
	});
});

describe("类型收窄", () => {
	it("isFontMarkColorToken 只接受五个 token", () => {
		const tokens: FontMarkSegment["color"][] = ["red", "gold", "blue", "green", "purple"];
		for (const token of tokens) {
			expect(isFontMarkColorToken(token)).toBe(true);
		}
		expect(isFontMarkColorToken("yellow")).toBe(false);
		expect(isFontMarkColorToken(undefined)).toBe(false);
	});
});
