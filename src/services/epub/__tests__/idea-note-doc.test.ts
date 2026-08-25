import { describe, expect, it } from "vitest";
import { EpubLinkService } from "../EpubLinkService";
import {
	type IdeaBlockIdentity,
	locateIdeaQuoteBlock,
	renderIdeaQuoteBlock,
	upsertIdeaEntry,
} from "../idea-note-doc";

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
	it("在摘录块原文之下以空引用行分隔，引出带时间戳的 💡 想法条目", () => {
		const quoteBlock = buildQuoteBlock("eid-1");
		const rendered = renderIdeaQuoteBlock(quoteBlock, [
			{ text: "想法第一行\n想法第二行", timestamp: "01-01 22:10" },
		]);
		expect(rendered).toBe(
			`${quoteBlock.replace(/\n+$/, "")}\n>\n> **💡 想法：** 01-01 22:10\n> 想法第一行\n> 想法第二行\n`
		);
	});

	it("无时间戳时标签行不拖尾空格；多条条目纵向堆叠", () => {
		const quoteBlock = buildQuoteBlock("eid-2");
		const rendered = renderIdeaQuoteBlock(quoteBlock, [
			{ text: "A1", timestamp: "01-01 22:10" },
			{ text: "A2", timestamp: "01-02 09:30" },
		]);
		expect(rendered).toBe(
			`${quoteBlock.replace(/\n+$/, "")}\n>\n> **💡 想法：** 01-01 22:10\n> A1\n>\n> **💡 想法：** 01-02 09:30\n> A2\n`
		);
	});

	it("没有条目时输出与纯摘录块一致", () => {
		const quoteBlock = buildQuoteBlock("eid-3");
		expect(renderIdeaQuoteBlock(quoteBlock, [])).toBe(quoteBlock);
	});
});

describe("locateIdeaQuoteBlock", () => {
	const doc = [
		"# 读书笔记",
		"",
		buildQuoteBlock("eid-A").trimEnd(),
		"",
		"中间的普通段落。",
		"",
		buildQuoteBlock("eid-B").trimEnd(),
		"",
	].join("\n");

	it("按深链中的划线标识定位对应块，区间恰好覆盖块的行", () => {
		const hit = locateIdeaQuoteBlock(doc, { eid: "eid-B" });
		expect(hit).not.toBeNull();
		const lines = doc.split("\n");
		const start = hit!.start.line;
		expect(lines[start]).toContain("[!EPUB");
		let end = start;
		while (end + 1 < lines.length && lines[end + 1].trimStart().startsWith(">")) {
			end += 1;
		}
		expect(hit!.end.line).toBe(end);
	});

	it("找不到匹配标识时返回 null", () => {
		expect(locateIdeaQuoteBlock(doc, { eid: "eid-Z" })).toBeNull();
	});

	it("无标识的历史块可按 CFI 兜底定位", () => {
		const legacyOnly = ["前言", "", buildQuoteBlock(undefined).trimEnd(), ""].join("\n");
		const hit = locateIdeaQuoteBlock(legacyOnly, { cfi: "epubcfi(/6/4!/4/2/2,/1:0,/2:5)" });
		expect(hit).not.toBeNull();
	});
});

describe("upsertIdeaEntry (票01：创建语义)", () => {
	it("目标文档没有该块时追加到末尾，且与既有内容以一个空行分隔", () => {
		const doc = "# 读书笔记\n\n一段旧内容。";
		const quoteBlock = buildQuoteBlock("eid-new");
		const result = upsertIdeaEntry(doc, { eid: "eid-new" }, { text: "A1", timestamp: "01-01 22:10" }, {
			quoteBlock,
		});
		expect(result.outcome).toBe("created");
		expect(result.doc).toBe(
			`${doc}\n\n${renderIdeaQuoteBlock(quoteBlock, [{ text: "A1", timestamp: "01-01 22:10" }])}`
		);
	});

	it("文档已以多个换行结尾时规范为恰好一个空行分隔", () => {
		const doc = "# 读书笔记\n\n\n";
		const quoteBlock = buildQuoteBlock("eid-new");
		const result = upsertIdeaEntry(doc, { eid: "eid-new" }, { text: "A1" }, { quoteBlock });
		expect(result.outcome).toBe("created");
		expect(result.doc).toBe(`# 读书笔记\n\n${renderIdeaQuoteBlock(quoteBlock, [{ text: "A1" }])}`);
	});

	it("补丁定位在文档末尾（from === to），可直接用于编辑器 replaceRange", () => {
		const doc = "# 笔记\n";
		const result = upsertIdeaEntry(doc, { eid: "e" }, { text: "x" }, { quoteBlock: buildQuoteBlock("e") });
		expect(result.patch).toBeDefined();
		expect(result.patch!.from).toEqual(result.patch!.to);
		const docLines = doc.split("\n");
		expect(result.patch!.from).toEqual({ line: docLines.length - 1, ch: docLines[docLines.length - 1].length });
	});

	it("目标块已存在时（票01 阶段）保持 no-op，不改一字", () => {
		const doc = ["# 笔记", "", buildQuoteBlock("eid-here").trimEnd(), ""].join("\n");
		const result = upsertIdeaEntry(
			doc,
			{ eid: "eid-here" },
			{ text: "新想法", timestamp: "01-02 08:00" },
			{ quoteBlock: buildQuoteBlock("eid-here") }
		);
		expect(result.outcome).toBe("noop");
		expect(result.doc).toBe(doc);
		expect(result.patch).toBeUndefined();
	});
});
