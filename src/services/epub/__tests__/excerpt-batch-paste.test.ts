import { describe, expect, it } from "vitest";
import {
	buildExcerptPasteBlocks,
	buildExcerptMergedPasteBlock,
	joinExcerptPasteBlocks,
	renderIdeaQuoteBlock,
	sortExcerptsForPaste,
	type ExcerptPasteBlockItem,
	type ExcerptPasteBuildContext,
} from "../excerpt-batch-paste";
import { EpubLinkService } from "../EpubLinkService";
import type { EpubHighlightStyle } from "../types";

/** 用真实生产者（摘录块构建服务）生成块文本，保证夹具与线上一致。 */
function buildQuoteBlock(excerptId?: string): string {
	const linkService = new EpubLinkService({} as never);
	return linkService.buildQuoteBlock(
		"books/demo.epub",
		"epubcfi(/6/4!/4/2/2,/1:0,/2:5)",
		"被划线的原文",
		2,
		"yellow",
		"第三章",
		undefined,
		undefined,
		undefined,
		excerptId,
		"underline"
	);
}

describe("renderIdeaQuoteBlock", () => {
	it("在摘录块原文之下以空引用行分隔，引出带时间戳的裸 💡 想法条目", () => {
		const quoteBlock = buildQuoteBlock("eid-1");
		const rendered = renderIdeaQuoteBlock(quoteBlock, [
			{ text: "想法第一行\n想法第二行", timestamp: "01-01 22:10" },
		]);
		expect(rendered).toBe(
			`${quoteBlock.replace(/\n+$/, "")}\n>\n> 💡 01-01 22:10\n> 想法第一行\n> 想法第二行\n`
		);
	});

	it("无时间戳时标签行不拖尾空格；多条条目纵向堆叠", () => {
		const quoteBlock = buildQuoteBlock("eid-2");
		const rendered = renderIdeaQuoteBlock(quoteBlock, [
			{ text: "A1", timestamp: "01-01 22:10" },
			{ text: "A2", timestamp: "01-02 09:30" },
		]);
		expect(rendered).toBe(
			`${quoteBlock.replace(/\n+$/, "")}\n>\n> 💡 01-01 22:10\n> A1\n>\n> 💡 01-02 09:30\n> A2\n`
		);
	});

	it("没有条目时输出与纯摘录块一致", () => {
		const quoteBlock = buildQuoteBlock("eid-3");
		expect(renderIdeaQuoteBlock(quoteBlock, [])).toBe(quoteBlock);
	});
});

interface PasteItem {
	id: string;
	createdTime?: number;
}

describe("sortExcerptsForPaste", () => {
	it("按 createdTime 升序排列（最早摘录在最上，与面板最新在上的显示顺序相反）", () => {
		const items: PasteItem[] = [
			{ id: "newest", createdTime: 3000 },
			{ id: "middle", createdTime: 2000 },
			{ id: "oldest", createdTime: 1000 },
		];
		expect(sortExcerptsForPaste(items).map((item) => item.id)).toEqual([
			"oldest",
			"middle",
			"newest",
		]);
	});

	it("不修改原数组（返回新数组）", () => {
		const items: PasteItem[] = [
			{ id: "a", createdTime: 2 },
			{ id: "b", createdTime: 1 },
		];
		sortExcerptsForPaste(items);
		expect(items.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("同 createdTime 并列时保持原有相对顺序（稳定排序）", () => {
		const items: PasteItem[] = [
			{ id: "first-of-tie", createdTime: 1000 },
			{ id: "second-of-tie", createdTime: 1000 },
			{ id: "older", createdTime: 500 },
		];
		expect(sortExcerptsForPaste(items).map((item) => item.id)).toEqual([
			"older",
			"first-of-tie",
			"second-of-tie",
		]);
	});

	it("缺失 createdTime 的条目视为最早（排在 0 之前，即最上）", () => {
		const items: PasteItem[] = [
			{ id: "with-time", createdTime: 500 },
			{ id: "no-time" },
			{ id: "also-no-time" },
		];
		expect(sortExcerptsForPaste(items).map((item) => item.id)).toEqual([
			"no-time",
			"also-no-time",
			"with-time",
		]);
	});
});

describe("joinExcerptPasteBlocks", () => {
	it("去掉每条块的末尾换行并以空行分隔（与逐次追加到末尾的既有排版一致）", () => {
		const joined = joinExcerptPasteBlocks([
			"> [!EPUB] 链接\n> 第一条\n",
			"> [!EPUB] 链接\n> 第二条\n",
		]);
		expect(joined).toBe("> [!EPUB] 链接\n> 第一条\n\n> [!EPUB] 链接\n> 第二条");
	});

	it("丢弃空块", () => {
		const joined = joinExcerptPasteBlocks(["", "  \n", "> 有内容\n"]);
		expect(joined).toBe("> 有内容");
	});

	it("单个块仅去尾换行", () => {
		expect(joinExcerptPasteBlocks(["> 一条\n"])).toBe("> 一条");
	});

	it("空列表返回空串", () => {
		expect(joinExcerptPasteBlocks([])).toBe("");
	});
});

interface QuoteCall {
	filePath: string;
	cfi: string;
	text: string;
	chapterIndex?: number;
	color?: string;
	chapterTitle?: string;
	timestamp?: string;
	sourcePath?: string;
	sourceId?: string;
	excerptId?: string;
	style?: EpubHighlightStyle;
	chapterLabelMaxLength?: number;
}

/** 伪块构建器：记录传入参数并返回确定性块文本，避免测试依赖真实 EPUB 链接格式。 */
function createBuildHarness(overrides?: Partial<ExcerptPasteBuildContext>) {
	const calls: QuoteCall[] = [];
	const context: ExcerptPasteBuildContext = {
		filePath: "Books/demo.epub",
		sourceId: "book-src",
		sourcePath: "Notes/reading.md",
		addCreationTime: true,
		chapterLabelMaxLength: 24,
		buildQuoteBlock: (
			filePath,
			cfi,
			text,
			chapterIndex,
			color,
			chapterTitle,
			timestamp,
			sourcePath,
			sourceId,
			excerptId,
			style,
			chapterLabelMaxLength
		) => {
			calls.push({
				filePath,
				cfi,
				text,
				chapterIndex,
				color,
				chapterTitle,
				timestamp,
				sourcePath,
				sourceId,
				excerptId,
				style,
				chapterLabelMaxLength,
			});
			return `B:${cfi}|${style ?? "∅"}|${timestamp ?? "∅"}|${excerptId ?? "∅"}`;
		},
		...overrides,
	};
	return { calls, context };
}

function item(partial: Partial<ExcerptPasteBlockItem> & { cfiRange: string }): ExcerptPasteBlockItem {
	return {
		text: "默认原文",
		chapterIndex: 2,
		chapterLabel: "第二章",
		createdTime: 1000,
		noteTypeKey: "highlight",
		...partial,
	};
}

const FULL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const SHORT_TIMESTAMP_RE = /^\d{2}-\d{2} \d{2}:\d{2}$/;

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** 断言时间戳格式化的是 createdTime 那一刻（本地时区、零填充），而非粘贴时刻。 */
function expectFullTimestampOf(value: string | undefined, createdTime: number): void {
	expect(value).toBeTruthy();
	expect(value).toMatch(FULL_TIMESTAMP_RE);
	const date = new Date(createdTime);
	expect(value).toBe(
		`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
	);
}

function expectShortTimestampOf(value: string | undefined, createdTime: number): void {
	expect(value).toBeTruthy();
	expect(value).toMatch(SHORT_TIMESTAMP_RE);
	const date = new Date(createdTime);
	expect(value).toBe(`${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`);
}

describe("buildExcerptPasteBlocks", () => {
	it("按 createdTime 升序逐条构建引用块并单次拼接（最早摘录在最上，块间空行分隔）", () => {
		const { calls, context } = createBuildHarness({ addCreationTime: false });
		const newest = new Date(2026, 2, 10, 9, 0).getTime();
		const oldest = new Date(2026, 2, 1, 8, 0).getTime();
		const output = buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-new", text: "较新的划线", createdTime: newest }),
				item({ cfiRange: "cfi-old", text: "最早的划线", createdTime: oldest }),
			],
			context
		);
		expect(calls.map((call) => call.cfi)).toEqual(["cfi-old", "cfi-new"]);
		expect(output.content).toBe("B:cfi-old|∅|∅|∅\n\nB:cfi-new|∅|∅|∅");
		expect(output.count).toBe(2);
	});

	it("缺失 createdTime 的条目排在最前", () => {
		const { calls, context } = createBuildHarness();
		buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-with-time", createdTime: 500 }),
				item({ cfiRange: "cfi-no-time", createdTime: undefined }),
			],
			context
		);
		expect(calls.map((call) => call.cfi)).toEqual(["cfi-no-time", "cfi-with-time"]);
	});

	it("把构建上下文与条目字段透传给引用块构建器（书路径/来源/章节标签/样式位/最大长度）", () => {
		const { calls, context } = createBuildHarness();
		buildExcerptPasteBlocks(
			[
				item({
					cfiRange: "epubcfi(/6/4)",
					text: "原文",
					chapterIndex: 3,
					chapterLabel: "第三章 觉醒",
					color: "red",
					excerptId: "eid-abc",
					noteTypeKey: "underline",
					createdTime: undefined,
				}),
			],
			context
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			filePath: "Books/demo.epub",
			sourcePath: "Notes/reading.md",
			sourceId: "book-src",
			cfi: "epubcfi(/6/4)",
			text: "原文",
			chapterIndex: 3,
			chapterTitle: "第三章 觉醒",
			color: "red",
			excerptId: "eid-abc",
			style: "underline",
			chapterLabelMaxLength: 24,
		});
	});

	it("普通高亮不输出样式 token，仅 underline/strikethrough/wavy 输出样式位", () => {
		const { calls, context } = createBuildHarness();
		buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-plain", noteTypeKey: "highlight" }),
				item({ cfiRange: "cfi-wavy", noteTypeKey: "wavy" }),
				item({ cfiRange: "cfi-strike", noteTypeKey: "strikethrough" }),
			],
			context
		);
		expect(calls.map((call) => call.style)).toEqual([undefined, "wavy", "strikethrough"]);
	});

	it("开启「添加时间」时块后缀时间戳取摘录原始创建时间；关闭或缺失创建时间则无后缀", () => {
		const createdTime = new Date(2026, 2, 15, 8, 5).getTime();
		const { calls, context } = createBuildHarness();
		buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-ts", createdTime }),
				item({ cfiRange: "cfi-no-ts", createdTime: undefined }),
			],
			context
		);
		// 缺失创建时间排最前且不带后缀；有时间的条目带原始创建时间后缀。
		expect(calls[0].timestamp).toBeUndefined();
		expectFullTimestampOf(calls[1].timestamp, createdTime);
		const { calls: offCalls, context: offContext } = createBuildHarness({ addCreationTime: false });
		buildExcerptPasteBlocks([item({ cfiRange: "cfi-off", createdTime })], offContext);
		expect(offCalls[0].timestamp).toBeUndefined();
	});

	it("带想法的摘录在块内渲染想法条目（条目取摘录创建时间），无想法摘录为纯块", () => {
		const createdTime = new Date(2026, 2, 15, 8, 5).getTime();
		const { context } = createBuildHarness({
			buildQuoteBlock: (_filePath, cfi, text) => `> [!EPUB] head-${cfi}\n> ${text}\n`,
		});
		const output = buildExcerptPasteBlocks(
			[
				item({
					cfiRange: "cfi-idea",
					text: "原文",
					createdTime,
					hasCommentDivider: true,
					commentText: "写得太好了",
				}),
				item({ cfiRange: "cfi-bare", text: "无想法原文", createdTime }),
			],
			context
		);
		const ideaBlock = output.content.split("\n\n")[0];
		expect(ideaBlock).toContain("> [!EPUB] head-cfi-idea");
		expect(ideaBlock).toMatch(/> 💡 \d{2}-\d{2} \d{2}:\d{2}/);
		expect(ideaBlock).toContain("> 写得太好了");
		expect(output.content.split("\n\n")[1]).toBe("> [!EPUB] head-cfi-bare\n> 无想法原文");
		expect(output.count).toBe(2);
	});

	it("多行想法逐行保留为引用行", () => {
		const { context } = createBuildHarness({
			buildQuoteBlock: (_filePath, cfi, text) => `> [!EPUB] head-${cfi}\n> ${text}\n`,
		});
		const output = buildExcerptPasteBlocks(
			[item({ cfiRange: "cfi-multi", text: "原文", hasCommentDivider: true, commentText: "第一行\n第二行" })],
			context
		);
		expect(output.content).toContain("> 第一行");
		expect(output.content).toContain("> 第二行");
	});

	it("缺失 cfiRange 或文本的条目被跳过，不阻塞其余条目的粘贴", () => {
		const { calls, context } = createBuildHarness({ addCreationTime: false });
		const output = buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-ok", text: "正常条目" }),
				item({ cfiRange: "", text: "无 cfi" }),
				item({ cfiRange: "cfi-no-text", text: "" }),
			],
			context
		);
		expect(calls.map((call) => call.cfi)).toEqual(["cfi-ok"]);
		expect(output.content).toBe("B:cfi-ok|∅|∅|∅");
		expect(output.count).toBe(1);
	});

	it("单条构建抛错（构建器异常）被跳过，其余摘录照常粘贴且计数准确", () => {
		const { context } = createBuildHarness({
			buildQuoteBlock: (_filePath, cfi) => {
				if (cfi === "cfi-bad") {
					throw new Error("boom");
				}
				return `B:${cfi}`;
			},
		});
		const output = buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-good", createdTime: 200 }),
				item({ cfiRange: "cfi-bad", createdTime: 100 }),
			],
			context
		);
		expect(output.content).toBe("B:cfi-good");
		expect(output.count).toBe(1);
	});

	it("引用原文与 cfiRange 原样传给构建器（与划线自动插入一致，不裁剪首尾空白）", () => {
		const { calls, context } = createBuildHarness();
		buildExcerptPasteBlocks(
			[item({ cfiRange: "  epubcfi(/6/4)  ", text: "  前后留白的原文  ", createdTime: undefined })],
			context
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].cfi).toBe("  epubcfi(/6/4)  ");
		expect(calls[0].text).toBe("  前后留白的原文  ");
	});

	it("全部条目无效时返回空内容与零计数", () => {
		const { context } = createBuildHarness();
		const output = buildExcerptPasteBlocks([item({ cfiRange: "", text: "" })], context);
		expect(output.content).toBe("");
		expect(output.count).toBe(0);
	});

	it("keys 只回传实际构建成功的条目 key（cfiRange 口径），供宿主精确回写已粘贴标记", () => {
		const { context } = createBuildHarness();
		const output = buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-good-1", key: "cfi-good-1", createdTime: 300 }),
				item({ cfiRange: "cfi-bad", key: "cfi-bad", text: "", createdTime: 200 }),
				item({ cfiRange: "cfi-good-2", key: "cfi-good-2", createdTime: 100 }),
			],
			context
		);
		expect(output.keys).toEqual(["cfi-good-2", "cfi-good-1"]);
	});

	it("缺失 key 或构建失败的条目不出现在 keys 中", () => {
		const { context } = createBuildHarness();
		const output = buildExcerptPasteBlocks(
			[
				item({ cfiRange: "cfi-no-key", createdTime: 200 }),
				item({ cfiRange: "cfi-throw", key: "cfi-throw", createdTime: 100 }),
			],
			{
				...context,
				buildQuoteBlock: (...args: Parameters<ExcerptPasteBuildContext["buildQuoteBlock"]>) => {
					if (args[1] === "cfi-throw") {
						throw new Error("构建器异常");
					}
					return "B";
				},
			}
		);
		expect(output.keys).toEqual([]);
	});
});
describe("buildExcerptMergedPasteBlock", () => {
	const mergedContext = (overrides?: Partial<ExcerptPasteBuildContext>) => {
		const harness = createBuildHarness(overrides);
		const recording = harness.context.buildQuoteBlock;
		harness.context.buildQuoteBlock = (...args: Parameters<ExcerptPasteBuildContext["buildQuoteBlock"]>) => {
			recording(...args); // 仍走默认伪构建器记录全部参数
			return `> [!EPUB] head-${args[1]}
> ${args[2]}
`;
		};
		return harness;
	};

	it("多条摘录合并为一个块：文本展平、同行「 …… 」接续、深链取最早一条", () => {
		const { calls, context } = mergedContext({ addCreationTime: false });
		const output = buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-new", key: "cfi-new", text: "第二条摘录", createdTime: 200 }),
				item({ cfiRange: "cfi-old", key: "cfi-old", text: "第一条摘录", createdTime: 100 }),
			],
			context
		)!;
		expect(calls).toHaveLength(1);
		expect(calls[0].cfi).toBe("cfi-old");
		expect(output.content).toBe("> [!EPUB] head-cfi-old\n> 第一条摘录 …… 第二条摘录");
		expect(output.count).toBe(2);
		expect(output.keys).toEqual(["cfi-old", "cfi-new"]);
	});

	it("摘录内部换行展平为单个空格", () => {
		const { calls, context } = mergedContext({ addCreationTime: false });
		buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-a", text: "第一行\n第二行", createdTime: 100 }),
				item({ cfiRange: "cfi-b", text: "第三行\n\n第四行", createdTime: 200 }),
			],
			context
		);
		expect(calls[0].text).toBe("第一行 第二行 …… 第三行 第四行");
	});

	it("带想法摘录自成一段并紧跟标准想法条目行（含创建时间），无想法摘录同行省略号接续", () => {
		const { calls, context } = mergedContext({ addCreationTime: true });
		const createdTime = new Date(2026, 2, 15, 8, 5).getTime();
		buildExcerptMergedPasteBlock(
			[
				item({
					cfiRange: "cfi-idea",
					key: "cfi-idea",
					text: "有想法的原文",
					createdTime,
					hasCommentDivider: true,
					commentText: "多行想法\n第二行",
					}),
				item({ cfiRange: "cfi-bare1", text: "无想法原文一", createdTime }),
				item({ cfiRange: "cfi-bare2", text: "无想法原文二", createdTime }),
			],
			context
		);
		// 条目行格式与「想法入笔记」一致：`> 💡 MM-DD HH:mm`，条目段以空引用行分隔。
		expect(calls[0].text).toBe(
			"有想法的原文\n\n💡 03-15 08:05\n多行想法 第二行\n\n无想法原文一 …… 无想法原文二"
		);
	});

	it("想法条目在块内标准位置：首位带想法摘录后接条目段，其余摘录另起一段", () => {
		const { calls, context } = mergedContext({ addCreationTime: false });
		buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-a", text: "甲", createdTime: 100 }),
				item({
					cfiRange: "cfi-b",
					text: "乙",
					createdTime: 200,
					hasCommentDivider: true,
					commentText: "乙的想法",
				}),
				item({ cfiRange: "cfi-c", text: "丙", createdTime: 300 }),
			],
			context
		);
		expect(calls[0].text).toBe("甲\n\n乙\n\n💡 01-01 08:00\n乙的想法\n\n丙");
	});

	it("仅一条有效摘录时退回普通单条块格式（保留章节标签与时间戳，无省略号）", () => {
		const createdTime = new Date(2026, 2, 15, 8, 5).getTime();
		const { calls, context } = createBuildHarness();
		const output = buildExcerptMergedPasteBlock(
			[item({ cfiRange: "cfi-one", text: "唯一摘录", createdTime })],
			context
		)!;
		expect(calls).toHaveLength(1);
		expect(calls[0].chapterTitle).toBe("第二章");
		expect(calls[0].timestamp).toMatch(FULL_TIMESTAMP_RE);
		expect(output.count).toBe(1);
	});

	it("块标题丢弃章节标签；样式位取各条一致样式，混样式输出无样式位", () => {
		const { calls, context } = mergedContext({ addCreationTime: false });
		buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-u1", noteTypeKey: "underline", createdTime: 100 }),
				item({ cfiRange: "cfi-u2", noteTypeKey: "underline", createdTime: 200 }),
			],
			context
		);
		expect(calls[0].chapterTitle).toBeUndefined();
		expect(calls[0].chapterIndex).toBeUndefined();
		expect(calls[0].style).toBe("underline");
		buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-mix1", noteTypeKey: "underline", createdTime: 100 }),
				item({ cfiRange: "cfi-mix2", noteTypeKey: "highlight", createdTime: 200 }),
			],
			context
		);
		expect(calls[1].style).toBeUndefined();
	});

	it("开启「添加时间」时合并块时间戳取最早一条摘录的创建时间", () => {
		const oldest = new Date(2026, 2, 1, 8, 0).getTime();
		const { calls, context } = mergedContext({ addCreationTime: true });
		buildExcerptMergedPasteBlock(
			[
				item({ cfiRange: "cfi-new", createdTime: oldest + 1000 }),
				item({ cfiRange: "cfi-old", createdTime: oldest }),
			],
			context
		);
		expectFullTimestampOf(calls[0].timestamp, oldest);
	});

	it("全部条目无效时返回 null", () => {
		const { context } = mergedContext();
		expect(buildExcerptMergedPasteBlock([item({ cfiRange: "", text: "" })], context)).toBeNull();
		expect(buildExcerptMergedPasteBlock([], context)).toBeNull();
	});
});
