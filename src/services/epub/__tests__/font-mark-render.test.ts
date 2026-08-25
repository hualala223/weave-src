import { describe, expect, it } from "vitest";
import {
	FONT_MARK_COLOR_TOKENS,
	FONT_MARK_EXPORT_HEX,
	resolveFontMarkBookTint,
} from "../font-mark-decoration";
import type { ReaderFontMark } from "../reader-engine-types";
import {
	buildFontMarkHighlightCss,
	getFontMarkHighlightName,
	groupFontMarksBySectionIndex,
} from "../font-mark-render";

describe("getFontMarkHighlightName（高亮注册名）", () => {
	it("每个 token 生成 weave-fontmark-<token> 注册名", () => {
		expect(getFontMarkHighlightName("red")).toBe("weave-fontmark-red");
		expect(getFontMarkHighlightName("gold")).toBe("weave-fontmark-gold");
		expect(getFontMarkHighlightName("blue")).toBe("weave-fontmark-blue");
		expect(getFontMarkHighlightName("green")).toBe("weave-fontmark-green");
		expect(getFontMarkHighlightName("purple")).toBe("weave-fontmark-purple");
	});
});

describe("buildFontMarkHighlightCss（章节 head 注入样式）", () => {
	const css = buildFontMarkHighlightCss();

	it("为全部五个 token 各下发一条 ::highlight 规则", () => {
		for (const token of FONT_MARK_COLOR_TOKENS) {
			expect(css).toContain(`::highlight(${getFontMarkHighlightName(token)})`);
		}
	});

	it("浅色基线使用与导出一致的固定 hex（单一事实来源）", () => {
		for (const token of FONT_MARK_COLOR_TOKENS) {
			expect(css).toContain(`color: ${FONT_MARK_EXPORT_HEX[token]} !important`);
		}
	});

	it("深色主题经 data-weave-host-scheme 覆盖，色值取书内深色 tint", () => {
		for (const token of FONT_MARK_COLOR_TOKENS) {
			const darkTint = resolveFontMarkBookTint(token, "dark");
			expect(css).toContain(
				`[data-weave-host-scheme="dark"] ::highlight(${getFontMarkHighlightName(token)})`
			);
			expect(css).toContain(`color: ${darkTint} !important`);
		}
	});
});

describe("groupFontMarksBySectionIndex（按节分组）", () => {
	const marks: Array<ReaderFontMark & { section?: number }> = [
		{ cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:2)", color: "red" },
		{ cfiRange: "epubcfi(/6/4!/4/8,/1:0,/1:1)", color: "blue" },
		{ cfiRange: "epubcfi(/6/6!/4/2,/1:0,/1:3)", color: "gold" },
	];

	function createSectionResolver(mapping: Record<string, number | null>) {
		return (cfiRange: string) => mapping[cfiRange] ?? null;
	}

	it("同一节的标记聚在一组且保持原顺序", () => {
		const resolver = createSectionResolver({
			"epubcfi(/6/4!/4/2,/1:0,/1:2)": 0,
			"epubcfi(/6/4!/4/8,/1:0,/1:1)": 0,
			"epubcfi(/6/6!/4/2,/1:0,/1:3)": 1,
		});
		const grouped = groupFontMarksBySectionIndex(marks, resolver);
		expect(grouped.get(0)?.map((mark) => mark.cfiRange)).toEqual([
			"epubcfi(/6/4!/4/2,/1:0,/1:2)",
			"epubcfi(/6/4!/4/8,/1:0,/1:1)",
		]);
		expect(grouped.get(1)?.map((mark) => mark.color)).toEqual(["gold"]);
	});

	it("解析不出节索引的标记被静默丢弃（渲染跳过语义）", () => {
		const resolver = createSectionResolver({
			"epubcfi(/6/4!/4/2,/1:0,/1:2)": 0,
			"epubcfi(/6/4!/4/8,/1:0,/1:1)": null,
			"epubcfi(/6/6!/4/2,/1:0,/1:3)": null,
		});
		const grouped = groupFontMarksBySectionIndex(marks, resolver);
		expect(grouped.size).toBe(1);
		expect(grouped.get(0)).toHaveLength(1);
	});

	it("空集合返回空映射", () => {
		const grouped = groupFontMarksBySectionIndex([], () => 0);
		expect(grouped.size).toBe(0);
	});
});
