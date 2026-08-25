import { describe, expect, it } from "vitest";
import { EpubLinkService } from "../EpubLinkService";
import {
	type IdeaBlockIdentity,
	type IdeaNoteResult,
	locateIdeaQuoteBlock,
	mergeIdeaInlineRewrite,
	renderIdeaQuoteBlock,
	rewriteLastIdeaEntry,
	stripLastIdeaEntry,
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
		// 剪贴板兜底用的完整块文本
		expect(result.block).toBe(renderIdeaQuoteBlock(quoteBlock, [{ text: "A1", timestamp: "01-01 22:10" }]));
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

	it("目标块已存在时把新想法当作条目追加（appended），旧块内容保留", () => {
		const doc = ["# 笔记", "", buildQuoteBlock("eid-here").trimEnd(), ""].join("\n");
		const result = upsertIdeaEntry(
			doc,
			{ eid: "eid-here" },
			{ text: "新想法", timestamp: "01-02 08:00" },
			{ quoteBlock: buildQuoteBlock("eid-here") }
		);
		expect(result.outcome).toBe("appended");
		expect(result.doc).toBe(
			["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock("eid-here"), [
				{ text: "新想法", timestamp: "01-02 08:00" },
			]).trimEnd(), ""].join("\n")
		);
	});
});

describe("mergeIdeaInlineRewrite（同 CFI 重写保留身份）", () => {
	it("沿用原划线的 excerptId 与 createdTime，想法与分隔标记原样保留", () => {
		const existing = {
			cfiRange: "epubcfi(/6/4!)",
			text: "旧文本",
			color: "yellow",
			style: "underline" as const,
			commentText: "既有想法",
			createdTime: 111,
			excerptId: "eid-stable",
		};
		const next = { cfiRange: "epubcfi(/6/4!)", text: "新文本", color: "red", style: "wavy" as const };
		const merged = mergeIdeaInlineRewrite(existing, next);
		expect(merged.excerptId).toBe("eid-stable");
		expect(merged.createdTime).toBe(111);
		expect(merged.commentText).toBe("既有想法");
		expect(merged.text).toBe("新文本");
		expect(merged.color).toBe("red");
		expect(merged.style).toBe("wavy");
	});

	it("没有既有记录时行为等同新建（生成新身份、无想法）", () => {
		const merged = mergeIdeaInlineRewrite(undefined, { cfiRange: "c", text: "T" });
		expect(merged.cfiRange).toBe("c");
		expect(merged.excerptId).toBeTruthy();
		expect(merged.commentText).toBe("");
	});
});

describe("upsertIdeaEntry 追加语义（票02）", () => {
	const docWithBlock = (excerptId: string) =>
		["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock(excerptId), [
			{ text: "A1", timestamp: "01-01 22:10" },
		]).trimEnd(), ""].join("\n");

	it("同一划线再写新想法：旧条目下方追加新条目，历史不动（appended）", () => {
		const doc = docWithBlock("eid-A");
		const result = upsertIdeaEntry(
			doc,
			{ eid: "eid-A" },
			{ text: "A2", timestamp: "01-02 09:30" },
			{ quoteBlock: buildQuoteBlock("eid-A") }
		);
		expect(result.outcome).toBe("appended");
		expect(result.doc).toBe(
			["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock("eid-A"), [
				{ text: "A1", timestamp: "01-01 22:10" },
				{ text: "A2", timestamp: "01-02 09:30" },
			]).trimEnd(), ""].join("\n")
		);
	});

	it("新想法与最后一条完全相同时 no-op，文档一字不动", () => {
		const doc = docWithBlock("eid-S");
		const result = upsertIdeaEntry(
			doc,
			{ eid: "eid-S" },
			{ text: "A1", timestamp: "01-03 08:00" },
			{ quoteBlock: buildQuoteBlock("eid-S") }
		);
		expect(result.outcome).toBe("noop");
		expect(result.doc).toBe(doc);
		expect(result.patch).toBeUndefined();
	});

	it("追加补丁定位在块的最后一行之后而非文档末尾", () => {
		const doc = ["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock("eid-P"), [
			{ text: "A1", timestamp: "01-01 22:10" },
		]).trimEnd(), "", "结尾段落"].join("\n");
		const result = upsertIdeaEntry(
			doc,
			{ eid: "eid-P" },
			{ text: "A2", timestamp: "01-02 09:30" },
			{ quoteBlock: buildQuoteBlock("eid-P") }
		);
		expect(result.outcome).toBe("appended");
		const blockEndLine = result.patch!.from.line;
		const lines = doc.split("\n");
		expect(lines[blockEndLine]).toContain("A1");
		expect(lines.slice(blockEndLine + 1)).toContain("结尾段落");
	});
});

describe("rewriteLastIdeaEntry（票03：改写语义）", () => {
	const docWith = (excerptId: string, entries: { text: string; timestamp?: string }[]) =>
		["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock(excerptId), entries).trimEnd(), ""].join("\n");

	it("只改写最后一条条目，历史条目与块头逐字不动", () => {
		const doc = docWith("eid-R", [
			{ text: "A1", timestamp: "01-01 22:10" },
			{ text: "A2", timestamp: "01-02 09:30" },
		]);
		const headerLine = doc.split("\n").find((l) => l.includes("[!EPUB"))!;
		const result = rewriteLastIdeaEntry(doc, { eid: "eid-R" }, { text: "A2改", timestamp: "01-03 08:00" });
		expect(result.outcome).toBe("replaced");
		expect(result.doc).toBe(
			docWith("eid-R", [
				{ text: "A1", timestamp: "01-01 22:10" },
				{ text: "A2改", timestamp: "01-03 08:00" },
			])
		);
		// 块头（含旧时间戳）原样保留
		expect(result.doc.split("\n")[2]).toBe(headerLine);
	});

	it("改写内容与最后一条相同时 no-op，一字不动", () => {
		const doc = docWith("eid-N", [{ text: "A1", timestamp: "01-01 22:10" }]);
		const result = rewriteLastIdeaEntry(doc, { eid: "eid-N" }, { text: "A1", timestamp: "01-02 09:30" });
		expect(result.outcome).toBe("noop");
		expect(result.doc).toBe(doc);
		expect(result.patch).toBeUndefined();
	});

	it("块内尚无条目时降级为追加（appended）", () => {
		const doc = ["# 笔记", "", buildQuoteBlock("eid-B").trimEnd(), ""].join("\n");
		const result = rewriteLastIdeaEntry(doc, { eid: "eid-B" }, { text: "第一条", timestamp: "01-01 08:00" }, {
			quoteBlock: buildQuoteBlock("eid-B"),
		});
		expect(result.outcome).toBe("appended");
		expect(result.doc).toBe(docWith("eid-B", [{ text: "第一条", timestamp: "01-01 08:00" }]));
	});

	it("仅有 CFI 可匹配的历史块能被正确定位并改写", () => {
		const doc = ["# 笔记", "", buildQuoteBlock(undefined).trimEnd(), ""].join("\n");
		const result = rewriteLastIdeaEntry(
			doc,
			{ cfi: "epubcfi(/6/4!/4/2/2,/1:0,/2:5)" },
			{ text: "给历史块补想法", timestamp: "02-01 10:00" },
			{ quoteBlock: buildQuoteBlock(undefined) }
		);
		expect(result.outcome).toBe("appended");
		expect(result.doc).toContain("**💡 想法：** 02-01 10:00");
		expect(result.doc).toContain("给历史块补想法");
	});

	it("编辑时身份完全失配（块被删/在别处）→ 整块重建于末尾，旧内容不动", () => {
		const doc = "# 今天\n\n旧的段落\n";
		const result = rewriteLastIdeaEntry(
			doc,
			{ eid: "eid-elsewhere" },
			{ text: "新想法", timestamp: "02-02 10:00" },
			{ quoteBlock: buildQuoteBlock("eid-elsewhere") }
		);
		expect(result.outcome).toBe("created");
		expect(result.doc).toContain("旧的段落");
		expect(result.doc).toContain("> **💡 想法：** 02-02 10:00");
		expect(result.doc.indexOf("旧的段落") < result.doc.indexOf("[!EPUB")).toBe(true);
		expect(result.block).toContain("> **💡 想法：** 02-02 10:00");
	});
});

describe("stripLastIdeaEntry（票03：清空剥离语义）", () => {
	const docWith = (excerptId: string, entries: { text: string; timestamp?: string }[]) =>
		["# 笔记", "", renderIdeaQuoteBlock(buildQuoteBlock(excerptId), entries).trimEnd(), ""].join("\n");

	it("多条想法时只剥掉最后一条，其余原样", () => {
		const doc = docWith("eid-S2", [
			{ text: "A1", timestamp: "01-01 22:10" },
			{ text: "A2", timestamp: "01-02 09:30" },
		]);
		const result = stripLastIdeaEntry(doc, { eid: "eid-S2" });
		expect(result.outcome).toBe("stripped");
		expect(result.doc).toBe(docWith("eid-S2", [{ text: "A1", timestamp: "01-01 22:10" }]));
	});

	it("只剩一条时剥离后块退化为纯摘录块（无想法段）", () => {
		const doc = docWith("eid-S1", [{ text: "A1", timestamp: "01-01 22:10" }]);
		const result = stripLastIdeaEntry(doc, { eid: "eid-S1" });
		expect(result.outcome).toBe("stripped");
		const bare = ["# 笔记", "", buildQuoteBlock("eid-S1").trimEnd(), ""].join("\n");
		expect(result.doc).toBe(bare);
		expect(result.block).toBe(buildQuoteBlock("eid-S1").trimEnd());
	});

	it("块内没有条目时 no-op", () => {
		const doc = ["# 笔记", "", buildQuoteBlock("eid-E").trimEnd(), ""].join("\n");
		const result = stripLastIdeaEntry(doc, { eid: "eid-E" });
		expect(result.outcome).toBe("noop");
		expect(result.doc).toBe(doc);
		expect(result.patch).toBeUndefined();
	});
});

describe("五态语义表序列（票04）", () => {
	let doc: string;

	function step(next: IdeaNoteResult) {
		doc = next.doc;
		return next;
	}

	it("「A1 → A2 → 改写A2 → 清空A2」序列各态正确且中间产物符合直觉", () => {
		doc = "# 笔记\n";
		const eid = "eid-seq";

		// created
		const c1 = step(upsertIdeaEntry(doc, { eid }, { text: "A1", timestamp: "01-01 22:10" }, {
			quoteBlock: buildQuoteBlock(eid),
		}));
		expect(c1.outcome).toBe("created");
		expect(doc).toContain("> **💡 想法：** 01-01 22:10");

		// appended
		const c2 = step(upsertIdeaEntry(doc, { eid }, { text: "A2", timestamp: "01-02 09:30" }, {
			quoteBlock: buildQuoteBlock(eid),
		}));
		expect(c2.outcome).toBe("appended");
		expect(doc).toContain("> A1");
		expect(doc).toContain("> A2");

		// 相同 → noop
		const c3 = step(upsertIdeaEntry(doc, { eid }, { text: "A2", timestamp: "01-03 08:00" }, {
			quoteBlock: buildQuoteBlock(eid),
		}));
		expect(c3.outcome).toBe("noop");

		// replaced（编辑最后一条）
		const c4 = step(rewriteLastIdeaEntry(doc, { eid }, { text: "A2改", timestamp: "01-03 08:00" }));
		expect(c4.outcome).toBe("replaced");
		expect(doc).toContain("> A2改");
		expect(doc).toContain("> A1");
		expect(doc).not.toContain("> **💡 想法：** 01-02 09:30");

		// stripped（清空最后一条）
		const c5 = step(stripLastIdeaEntry(doc, { eid }));
		expect(c5.outcome).toBe("stripped");
		expect(doc).toContain("> A1");
		expect(doc).not.toContain("A2改");

		// 只剩一条时再剥 → 退化为纯摘录块；再剥 → noop
		const c6 = step(stripLastIdeaEntry(doc, { eid }));
		expect(c6.outcome).toBe("stripped");
		expect(doc).not.toContain("> A1");
		expect(doc).not.toContain("**💡 想法：**");
		const c7 = stripLastIdeaEntry(doc, { eid });
		expect(c7.outcome).toBe("noop");
	});

	it("全部失配（块被删/在别处）→ 重新追加完整块，旧内容不动", () => {
		const doc = "# 今天\n\n旧的段落\n";
		const result = upsertIdeaEntry(doc, { eid: "eid-gone" }, { text: "新想法", timestamp: "02-02 10:00" }, {
			quoteBlock: buildQuoteBlock("eid-gone"),
		});
		expect(result.outcome).toBe("created");
		expect(result.doc).toContain("旧的段落");
		expect(result.doc.indexOf("旧的段落") < result.doc.indexOf("[!EPUB")).toBe(true);
	});

	it("手动输出的随机标识旧块不被误认：编辑想法追加的是新规范块", () => {
		// 手动输出的块带随机 eid（真实生产者行为），以 CFI 定位追加首条想法时
		// 不得复制出第二份块：结果里必须恰好一个 EPUB 块头，旧块头原样保留。
		const legacy = buildQuoteBlock(undefined); // 随机 eid
		const doc = ["# 笔记", "", legacy.trimEnd(), ""].join("\n");
		const result = rewriteLastIdeaEntry(doc, { cfi: "epubcfi(/6/4!/4/2/2,/1:0,/2:5)" }, {
			text: "补的想法",
			timestamp: "02-02 10:00",
		}, { quoteBlock: buildQuoteBlock(undefined) });
		expect(result.outcome).toBe("appended");
		expect(result.doc).toContain("补的想法");
		expect(result.doc).toContain(legacy.split("\n")[0]); // 旧块头仍在
		expect(result.doc.match(/\[!EPUB/g)?.length).toBe(1); // 无第二份块
	});
});
