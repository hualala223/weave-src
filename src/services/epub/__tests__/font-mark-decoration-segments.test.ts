import { describe, expect, it } from "vitest";
import {
	buildExcerptDecorationSegments,
	decorateExcerptText,
	findFontMarkByText,
	type FontMarkSegment,
} from "../font-mark-decoration";

function buildDoc(html: string): Document {
	return new DOMParser().parseFromString(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
		"text/html",
	);
}

function makeParagraphRangeFactory(doc: Document) {
	const paragraphs = doc.body.querySelectorAll("p");
	return {
		resolveRange: (cfi: string): Range | null => {
			if (!cfi.startsWith('p')) {
				return null;
			}
			const [, index, start, end] = cfi.split(":").map(Number);
			const paragraph = paragraphs[index];
			if (!paragraph || !paragraph.firstChild) {
				return null;
			}
			const range = doc.createRange();
			range.setStart(paragraph.firstChild, start);
			range.setEnd(paragraph.firstChild, end);
			return range;
		},
	};
}

interface TestMark {
	cfiRange: string;
	text: string;
	color: FontMarkSegment["color"];
}

describe("buildExcerptDecorationSegments（导出装饰编排）", () => {
	it("经 Range 解析把落在划线内的标记换算成偏移切段", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const marks: TestMark[] = [{ cfiRange: "p:0:2:4", text: "天气", color: "red" }];

		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks,
			resolveRange,
		});

		expect(segments).toEqual<FontMarkSegment[]>([{ start: 2, end: 4, color: "red" }]);
	});

	it("Range 解析失败但摘录含标记文本 → 摘录内文本回退染色（票 08 二次修订）", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const marks: TestMark[] = [{ cfiRange: "broken", text: "天气", color: "blue" }];

		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks,
			resolveRange,
		});

		// 标记 Range 无法解析（broken）→ 偏移证明不可得 → 摘录内文本回退：
		// 「天气」在摘录中出现（偏移 2..4）→ 染色（用户主场景；偏移证明优先不变）。
		expect(segments).toEqual<FontMarkSegment[]>([{ start: 2, end: 4, color: "blue" }]);
		expect(decorateExcerptText("今天天气真好啊", segments)).toBe(
			'今天<span style="color:#2563eb">天气</span>真好啊',
		);
	});

	it("Range 解析失败但标记文本在摘录内多次出现 → 不做文本回退，输出纯文本（防误染唯一性闸）", () => {
		const doc = buildDoc("<p>目标决定方向，目标决定行动</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const text = "目标决定方向，目标决定行动";
		const marks: TestMark[] = [{ cfiRange: "broken", text: "目标", color: "red" }];

		// 「目标」在摘录里出现两次，无法证明用户标记的是哪一处——
		// 首现回退会染错位置（宁可漏染，不可错染），两级都失败被跳过。
		expect(
			buildExcerptDecorationSegments({ text, highlightCfiRange: "p:0:0:12", marks, resolveRange }),
		).toEqual<FontMarkSegment[]>([]);
	});

	it("Range 解析失败但标记文本在摘录内唯一出现 → 文本回退仍染色（票 08 场景保留）", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const marks: TestMark[] = [{ cfiRange: "broken", text: "真好", color: "green" }];

		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks,
			resolveRange,
		});

		expect(segments).toEqual<FontMarkSegment[]>([{ start: 4, end: 6, color: "green" }]);
	});

	it("Range 与字符串都失败时该项被跳过，剩余项仍生效", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const marks: TestMark[] = [
			{ cfiRange: "broken", text: "不存在的词", color: "green" },
			{ cfiRange: "p:0:6:7", text: "啊", color: "purple" },
		];

		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks,
			resolveRange,
		});

		expect(segments).toEqual<FontMarkSegment[]>([{ start: 6, end: 7, color: "purple" }]);
	});

	it("标记越界部分被裁剪；无重叠时返回空数组", () => {
		const doc = buildDoc("<p>零一二三四五六七八九</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const marks: TestMark[] = [
			{ cfiRange: "p:0:0:9", text: "零一二三四五六七八九", color: "red" },
			{ cfiRange: "p:0:8:10", text: "八九", color: "blue" },
		];

		const clipped = buildExcerptDecorationSegments({
			text: "二三四五",
			highlightCfiRange: "p:0:2:6",
			marks,
			resolveRange,
		});
		expect(clipped).toEqual<FontMarkSegment[]>([{ start: 0, end: 4, color: "red" }]);

		const disjoint = buildExcerptDecorationSegments({
			text: "二三四五",
			highlightCfiRange: "p:0:2:6",
			marks: [{ cfiRange: "p:0:8:10", text: "八九", color: "blue" }],
			resolveRange,
		});
		expect(disjoint).toEqual<FontMarkSegment[]>([]);
	});

	it("编排结果可直接喂给装饰函数得到带色摘录", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks: [
				{ cfiRange: "p:0:2:4", text: "天气", color: "red" },
				{ cfiRange: "p:0:6:7", text: "啊", color: "gold" },
			],
			resolveRange,
		});

		expect(decorateExcerptText("今天天气真好啊", segments)).toBe(
			'今天<span style="color:#dc2626">天气</span>真好<span style="color:#b45309">啊</span>',
		);
	});
});

describe("辅助：空输入与容错", () => {
	it("空文本/空标记/无解析器都不抛异常", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		expect(
			buildExcerptDecorationSegments({
				text: "",
				highlightCfiRange: "p:0:0:7",
				marks: [],
				resolveRange,
			}),
		).toEqual([]);
		expect(
			buildExcerptDecorationSegments({
				text: "今天天气真好啊",
				highlightCfiRange: "",
				marks: [],
				resolveRange,
			}),
		).toEqual([]);
	});
});