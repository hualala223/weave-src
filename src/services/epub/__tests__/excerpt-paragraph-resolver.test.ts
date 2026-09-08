import { describe, expect, it } from "vitest";
import { resolveExcerptParagraph } from "../excerpt-paragraph-resolver";
import type { ReaderParagraph } from "../reader-engine-types";

function makeParagraph(overrides: Partial<ReaderParagraph> & { text: string }): ReaderParagraph {
	return {
		id: overrides.id || `p:${overrides.text.slice(0, 6)}`,
		chapterIndex: 3,
		chapterTitle: "第三章",
		chapterHref: "chapter3.xhtml",
		cfiRange: overrides.cfiRange || `epubcfi(/6/4!/4/2,/1:0,/1:${overrides.text.length})`,
		...overrides,
	};
}

describe("resolveExcerptParagraph", () => {
	it("摘录文本被唯一段落包含时，返回该段落与原始偏移高亮区间", () => {
		const paragraphs = [
			makeParagraph({ text: "这是第一段，讲别的事情。" }),
			makeParagraph({ text: "窗外的雨下个不停，屋檐滴水成线。他望着远方出神。" }),
		];
		const match = resolveExcerptParagraph({
			excerptCfi: "epubcfi(/6/4!/4/4,/1:3,/1:11)",
			excerptText: "雨下个不停，屋檐滴水",
			paragraphs,
		});

		expect(match.status).toBe("matched");
		expect(match.paragraph).toBe(paragraphs[1]);
		expect(match.highlight).toEqual({
			start: paragraphs[1].text.indexOf("雨下个不停"),
			end: paragraphs[1].text.indexOf("雨下个不停") + "雨下个不停，屋檐滴水".length,
		});
	});

	it("原文含换行/多余空白时按归一化文本匹配，偏移映射回原文", () => {
		const raw = "第一行内容。\n  第二行   内容延续。";
		const paragraphs = [makeParagraph({ text: raw })];
		const match = resolveExcerptParagraph({
			excerptCfi: "epubcfi(/6/4!/4/2,/1:0,/1:5)",
			excerptText: "第二行 内容延续",
			paragraphs,
		});

		expect(match.status).toBe("matched");
		expect(match.highlight).toEqual({ start: raw.indexOf("第二行"), end: raw.length - 1 });
	});

	it("跨段落划线：整段文本不命中时，取落在本段内的最长句读片段做高亮", () => {
		const paragraphs = [
			makeParagraph({ text: "前一段的最后一句是夜色渐深。" }),
			makeParagraph({ text: "新的一段从黎明开始写起，然后日头升高。" }),
		];
		const match = resolveExcerptParagraph({
			excerptCfi: "epubcfi(/6/4!/4/2,/1:0,/1:5)",
			excerptText: "夜色渐深。新的一段从黎明开始写起",
			paragraphs,
		});

		expect(match.status).toBe("matched");
		expect(match.paragraph).toBe(paragraphs[1]);
		expect(match.highlight).toEqual({
			start: paragraphs[1].text.indexOf("新的一段从黎明开始写起"),
			end: paragraphs[1].text.indexOf("新的一段从黎明开始写起") + "新的一段从黎明开始写起".length,
		});
	});

	it("文本对不上但 CFI 段落级父路径一致时，返回该段落且无高亮（降级）", () => {
		const cfiRange = "epubcfi(/6/4!/4/2,/1:0,/1:40)";
		const paragraphs = [makeParagraph({ text: "段落原文变了，与摘录文本不再一致。", cfiRange })];
		const match = resolveExcerptParagraph({
			excerptCfi: cfiRange,
			excerptText: "书改版前的旧文本内容",
			paragraphs,
		});

		expect(match.status).toBe("matched");
		expect(match.paragraph).toBe(paragraphs[0]);
		expect(match.highlight).toBeNull();
	});

	it("文本与 CFI 都对不上时返回 text-miss", () => {
		const paragraphs = [makeParagraph({ text: "完全无关的段落内容。" })];
		const match = resolveExcerptParagraph({
			excerptCfi: "epubcfi(/6/4!/4/8,/1:0,/1:5)",
			excerptText: "不存在的摘录文本",
			paragraphs,
		});

		expect(match.status).toBe("text-miss");
		expect(match.paragraph).toBeNull();
		expect(match.highlight).toBeNull();
	});

	it("坏 CFI（不可解析）不抛错：有文本仍按文本匹配", () => {
		const paragraphs = [makeParagraph({ text: "窗外的雨下个不停。" })];
		const match = resolveExcerptParagraph({
			excerptCfi: "not-a-cfi",
			excerptText: "雨下个不停",
			paragraphs,
		});

		expect(match.status).toBe("matched");
		expect(match.highlight).not.toBeNull();
	});

	it("空段落列表或空输入返回 invalid，不抛错", () => {
		expect(
			resolveExcerptParagraph({ excerptCfi: "epubcfi(/6/4)", excerptText: "x", paragraphs: [] })
				.status
		).toBe("invalid");
		expect(
			resolveExcerptParagraph({ excerptCfi: "", excerptText: "  ", paragraphs: [makeParagraph({ text: "有内容" })] })
				.status
		).toBe("invalid");
	});
});
