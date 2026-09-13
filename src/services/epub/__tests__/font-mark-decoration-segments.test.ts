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

	it("词多次出现时：即便创建时快照与其中一处吻合，也不染（快照不足以证明，防误染唯一性闸）", () => {
		const doc = buildDoc("<p>设定目标后行动，调整目标再前行</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const text = "设定目标后行动，调整目标再前行";
		// 「目标」在摘录内出现两次。快照（前文「调整」、后文「再前行」）恰好与
		// 第二处吻合——但快照本身也可能来自同节另一段落的同名标记（该处上下文
		// 恰好与摘录里这一段相同），无法据此证明用户标的就是摘录内这一处；
		// 规格明确：目标词未在摘录内唯一出现时一律不产生装饰段。
		const marks: TestMark[] = [
			{
				cfiRange: "broken",
				text: "目标",
				color: "blue",
				before: "调整",
				after: "再前行",
			} as TestMark & { before: string; after: string },
		];

		const segments = buildExcerptDecorationSegments({
			text,
			highlightCfiRange: "p:0:0:14",
			marks,
			resolveRange,
		});

		expect(segments).toEqual<FontMarkSegment[]>([]);
	});

	it("上下文不吻合：词虽出现但前后文与快照不符 → 不染（宁可漏染，不可错染）", () => {
		const doc = buildDoc("<p>设定目标后行动，调整目标再前行</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const text = "设定目标后行动，调整目标再前行";
		// 快照来自另一段落的上下文，与摘录中两处出现都不吻合。
		const marks: TestMark[] = [
			{
				cfiRange: "broken",
				text: "目标",
				color: "red",
				before: "明确",
				after: "优先级",
			} as TestMark & { before: string; after: string },
		];

		expect(
			buildExcerptDecorationSegments({ text, highlightCfiRange: "p:0:0:14", marks, resolveRange }),
		).toEqual<FontMarkSegment[]>([]);
	});

	it("词唯一出现时：快照是否吻合都不影响染色（唯一出现本身即证明）", () => {
		const doc = buildDoc("<p>今天天气真好啊</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		// 快照与摘录内前文不吻合（来自别处），但「真好」在摘录内唯一出现，
		// 该处只能是用户标记的那个词，按唯一性闸照常染色。
		const marks: TestMark[] = [
			{
				cfiRange: "broken",
				text: "真好",
				color: "green",
				before: "无关前文",
				after: "无关后文",
			} as TestMark & { before: string; after: string },
		];

		const segments = buildExcerptDecorationSegments({
			text: "今天天气真好啊",
			highlightCfiRange: "p:0:0:7",
			marks,
			resolveRange,
		});

		expect(segments).toEqual<FontMarkSegment[]>([{ start: 4, end: 6, color: "green" }]);
	});

	it("Range 解析失败但标记文本在摘录内多次出现且无上下文快照 → 不做文本回退，输出纯文本（防误染唯一性闸）", () => {
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

describe("真实书回归：《原则》摘录误染（export-font-mark-decoration-misdye 票 03）", () => {
	/**
	 * 用户实测场景：笔记《原则.md》的摘录块（Block「排列优先顺序…」）里，
	 * 异段同名标记把「得到/选择/目标」等多出现词染进了摘录。
	 *
	 * 根因：旧版文本回退用 findFontMarkByText 取首现、无唯一性闸，
	 * 于是每个「在摘录里出现过」的标记词都被染色（含第 2、3 次出现）。
	 * 修复后：多出现词一律不染（快照亦不足为证），仅唯一出现词可染。
	 */
	it("异段标记：多出现词不染，唯一出现词才染（防误染唯一性闸）", () => {
		const doc = buildDoc(
			"<p>排列优先顺序：尽管你几乎可以得到你想要的任何东西，但你不可能得到你想要的所有东西</p>" +
				"<p>选择一个目标通常意味着放弃你想要的一些东西，以得到另一些你更想要或更需要的东西</p>",
		);
		const { resolveRange } = makeParagraphRangeFactory(doc);
		// 摘录（与真实笔记 Block「排列优先顺序…」逐字一致）：
		// 多出现词 得到×3 / 选择×2 / 目标×2，唯一词 优先 / 放弃 / 同时 / 持守。
		const text =
			"排列优先顺序：尽管你几乎可以得到你想要的任何东西，但你不可能得到你想要的所有东西 …… 选择一个目标通常意味着放弃你想要的一些东西，以得到另一些你更想要或更需要的东西 …… 试图同时追求太多目标，最终却几乎一个都不能实现。 …… 做出自己的选择并持守它。";
		// 这些标记实际钉在另一段落（异段），Range 解析失败（"broken"）→ 走文本回退。
		const marks: TestMark[] = [
			{ cfiRange: "broken", text: "得到", color: "red" },
			{ cfiRange: "broken", text: "选择", color: "red" },
			{ cfiRange: "broken", text: "目标", color: "red" },
			{ cfiRange: "broken", text: "优先", color: "red" },
			{ cfiRange: "broken", text: "放弃", color: "red" },
			{ cfiRange: "broken", text: "同时", color: "red" },
			{ cfiRange: "broken", text: "持守", color: "red" },
		];

		const segments = buildExcerptDecorationSegments({
			text,
			highlightCfiRange: "p:0:0:40",
			marks,
			resolveRange,
		});

		// 只有摘录内唯一出现的词可染；多出现的「得到/选择/目标」一律不染。
		const colored = segments.map((s) => text.slice(s.start, s.end));
		expect(colored.sort()).toEqual(["优先", "同时", "放弃", "持守"].sort());
	});

	it("即便带创建时上下文快照，多出现词仍不染（快照不构成证明）", () => {
		const doc = buildDoc("<p>首先，你要选择你追求什么，即你的目标。对目标的选择将决定你的方向</p>");
		const { resolveRange } = makeParagraphRangeFactory(doc);
		const text = "首先，你要选择你追求什么，即你的目标。对目标的选择将决定你的方向";
		// 异段标记「目标」带快照，快照恰好与摘录内某处吻合——仍不足为证。
		const marks: TestMark[] = [
			{
				cfiRange: "broken",
				text: "目标",
				color: "red",
				before: "即你的",
				after: "。对目标",
			} as TestMark & { before: string; after: string },
		];

		expect(
			buildExcerptDecorationSegments({ text, highlightCfiRange: "p:0:0:24", marks, resolveRange }),
		).toEqual<FontMarkSegment[]>([]);
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