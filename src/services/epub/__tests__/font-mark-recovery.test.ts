import { describe, expect, it } from "vitest";
import { recoverExportFontMarkRanges, recoverFontMarkRange } from "../font-mark-render";
import { buildExcerptDecorationSegments, decorateExcerptText } from "../font-mark-decoration";

/**
 * 三路共用找回（渲染/导出/点击）的外部行为契约。
 *
 * 测试只断言外部行为：给定（文档、节号、标记节号、解析器行为、文本）→
 * 断言找回出的 Range / null。解析器用「hint 敏感」假实现来观测 hint 是否传递——
 * hint 传递是本功能的对外约定（同节文本找回），不是内部实现细节。
 */

function buildDoc(html: string): Document {
	return new DOMParser().parseFromString(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
		"text/html",
	);
}

/** 在 doc 中定位 word 并返回覆盖它的 Range（找不到则抛错，测试自证）。 */
function rangeFor(doc: Document, word: string): Range {
	const walker = doc.createTreeWalker(doc.body!, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		const index = node.data.indexOf(word);
		if (index >= 0) {
			const range = doc.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + word.length);
			return range;
		}
	}
	throw new Error(`word not found in fixture: ${word}`);
}

const BASE = {
	sectionIndex: 0,
	allowSectionTextHint: true,
	cfiRange: "epubcfi(/6/4!/4/2)",
};

describe("recoverFontMarkRange（三路共用标记 Range 找回）", () => {
	it("CFI 锚解析成功且 Range 覆盖标记文本 → 直接返回解析出的 Range", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const resolved = rangeFor(doc, "经济学");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => resolved,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学");
	});

	it("锚解析失败（无 hint）时把标记文本作为 hint 找回 → 返回找回 Range", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const hinted = rangeFor(doc, "经济学");
		// hint 敏感解析器：只有收到文本 hint 才成功（模拟引述找回）。
		const resolveRangeInDocument = (cfi: string, textHint?: string) =>
			textHint ? hinted : null;
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument,
		});
		expect(result).not.toBeNull();
	});

	it("同节重复词 + 锚失败：文本找回钉到首个同文位置 → 唯一性闸放弃（宁可不染）", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const firstOccurrence = rangeFor(doc, "经济学"); // 文本找回钉住的首个出现
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: (cfi: string, textHint?: string) =>
				textHint ? firstOccurrence : null,
		});
		expect(result).toBeNull();
	});

	it("CFI 锚解析成功 + 词在节内多次出现 → 仍采用（CFI 证明不受唯一性闸影响）", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const firstOccurrence = rangeFor(doc, "经济学");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => firstOccurrence, // 无 hint 即 CFI 解析成功
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学");
	});

	it("锚解析出的 Range 文本不覆盖标记文本（错位锚）→ 视为未解析，短词唯一出现时走兜底", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const misresolved = rangeFor(doc, "原理"); // 锚错位：指向别的词
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => misresolved,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学"); // 兜底找回的是标记词本身
	});

	it("短词（2~3 字）在节内唯一出现 + 锚失败 → 兜底返回其 Range", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => null,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学");
	});

	it("短词在节内出现多次 + 锚失败 → 返回 null（宁可不染，不可错配）", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => null,
		});
		expect(result).toBeNull();
	});

	it("≥4 字词 + 锚失败 → 返回 null（引述找回不适用短词兜底）", () => {
		const doc = buildDoc("<p>这是一句足够长的引述文字</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "这是一句足够长",
			resolveRangeInDocument: () => null,
		});
		expect(result).toBeNull();
	});

	it("异节标记（markSection ≠ sectionIndex）不传文本 hint：锚失败即 null", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const hinted = rangeFor(doc, "经济学");
		const resolveRangeInDocument = (cfi: string, textHint?: string) =>
			textHint ? hinted : null;
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 1, // 异节：无法证明归属
			text: "经济学",
			resolveRangeInDocument,
		});
		// 若错误地传了 hint，解析器会成功；传递 hint 被禁止时结果必须为 null。
		expect(result).toBeNull();
	});

	it("异节标记但锚解析本身成功（无 hint）→ 返回，不因异节丢弃锚结果", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const resolved = rangeFor(doc, "经济学");
		const resolveRangeInDocument = () => resolved;
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 1,
			text: "经济学",
			resolveRangeInDocument,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学");
	});

	it("allowSectionTextHint=false 时锚失败不传 hint，但短词兜底仍可用（同节证明）", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const hinted = rangeFor(doc, "经济学");
		const resolveRangeInDocument = (cfi: string, textHint?: string) =>
			textHint ? hinted : null;
		const result = recoverFontMarkRange({
			...BASE,
			allowSectionTextHint: false,
			doc,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("经济学"); // 兜底路径不经 hint
	});

	it("allowSectionTextHint=false、≥4 字且锚失败 → 返回 null", () => {
		const doc = buildDoc("<p>这是一句足够长的引述文字</p>");
		const resolveRangeInDocument = (cfi: string, textHint?: string) =>
			textHint ? rangeFor(doc, "这是一句足够长") : null;
		const result = recoverFontMarkRange({
			...BASE,
			allowSectionTextHint: false,
			doc,
			markSection: 0,
			text: "这是一句足够长",
			resolveRangeInDocument,
		});
		expect(result).toBeNull();
	});

	it("解析器抛异常 → 视为解析失败；无短词兜底时返回 null，不冒泡", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "这是一句足够长",
			resolveRangeInDocument: () => {
				throw new Error("parse boom");
			},
		});
		expect(result).toBeNull();
	});

	it("空标记文本 → 不传 hint、无兜底；锚解析成功则返回", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const resolved = rangeFor(doc, "经济学");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "",
			resolveRangeInDocument: () => resolved,
		});
		expect(result).not.toBeNull();
	});

	it("doc 为空 / 短词兜底不可行时返回 null，不抛异常", () => {
		const result = recoverFontMarkRange({
			...BASE,
			doc: null,
			markSection: 0,
			text: "经济学",
			resolveRangeInDocument: () => null,
		});
		expect(result).toBeNull();
	});
});

describe("recoverExportFontMarkRanges（导出侧找回编排：划线基线 + 标记找回）", () => {
	const HIGHLIGHT_CFI = "epubcfi(/6/4!/4/2,/1:0,/1:11)";
	const MARK_CFI = "epubcfi(/6/4!/4/2,/1:3,/1:6)";

	function buildSectionResolver(mapping: Record<string, number | null>) {
		return (cfiRange: string) => mapping[cfiRange] ?? null;
	}

	it("锚失败但短词在节内唯一出现 → 该标记键有 Range（兜底找回）", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const highlight = rangeFor(doc, "这本书讲经济学原理");
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? highlight : null,
		});
		expect(ranges.get(HIGHLIGHT_CFI)).not.toBeNull();
		expect(ranges.get(MARK_CFI)).not.toBeNull();
		expect(ranges.get(MARK_CFI)!.toString()).toBe("经济学");
	});

	it("锚解析成功（结构）→ 标记键直接用解析结果", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const highlight = rangeFor(doc, "这本书讲经济学原理");
		const markRange = rangeFor(doc, "经济学");
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? highlight : markRange,
		});
		expect(ranges.get(MARK_CFI)).not.toBeNull();
		expect(ranges.get(MARK_CFI)!.toString()).toBe("经济学");
	});

	it("短词出现多次（无法唯一判定）→ 该标记键为 null（宁可不染）", () => {
		const doc = buildDoc("<p>经济学第一段</p><p>经济学第二段</p>");
		const paragraphs = doc.body.querySelectorAll("p");
		const highlight = doc.createRange();
		highlight.setStart(paragraphs[0].firstChild!, 0);
		highlight.setEnd(paragraphs[1].firstChild!, 4);
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? highlight : null,
		});
		expect(ranges.get(MARK_CFI)).toBeNull();
	});

	it("≥4 字词且锚失败 → 该标记键为 null（引述找回不适用短词兜底）", () => {
		const doc = buildDoc("<p>这是一句足够长的引述文字</p>");
		const highlight = rangeFor(doc, "这是一句足够长");
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "这是一句足够长" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? highlight : null,
		});
		expect(ranges.get(MARK_CFI)).toBeNull();
	});

	it("异节标记不传文本 hint → 该标记键为 null；划线基线不受影响", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const highlight = rangeFor(doc, "这本书讲经济学原理");
		const hinted = rangeFor(doc, "经济学");
		// hint 敏感解析器：只有收到文本 hint 才返回 Range（若错误传 hint 会成功）。
		const resolveRangeInDocument = (cfiRange: string, textHint?: string) =>
			cfiRange === HIGHLIGHT_CFI ? highlight : textHint ? hinted : null;
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 1, // 异节：无法证明归属
			}),
			resolveRangeInDocument,
		});
		expect(ranges.get(HIGHLIGHT_CFI)).not.toBeNull();
		expect(ranges.get(MARK_CFI)).toBeNull();
	});

	it("划线基线的节号解析失败 → 该键为 null，标记键仍独立找回", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: null, // 划线节号解析失败
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? rangeFor(doc, "这本书讲经济学原理") : null,
		});
		expect(ranges.get(HIGHLIGHT_CFI)).toBeNull();
		expect(ranges.get(MARK_CFI)).not.toBeNull();
	});

	it("导出端到端：找回后的 Range 穿过装饰编排产生精确切段并包出 span（症状 1 全链）", () => {
		const doc = buildDoc("<p>这本书讲经济学原理</p>");
		const highlight = rangeFor(doc, "这本书讲经济学原理");
		const excerpt = "这本书讲经济学原理";
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? highlight : null,
		});
		const segments = buildExcerptDecorationSegments({
			text: excerpt,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveRange: (cfiRange) => ranges.get(cfiRange) ?? null,
		});
		// 「经济学」在摘录中偏移 4..7。
		expect(segments).toEqual([{ start: 4, end: 7, color: "red" }]);
		expect(decorateExcerptText(excerpt, segments)).toBe(
			'这本书讲<span style="color:#dc2626">经济学</span>原理'
		);
	});

	it("全部找回失败 → 装饰编排空段、摘录原样输出（无色纯文本退化，不阻塞导出）", () => {
		const doc = buildDoc("<p>不相关的内容</p>");
		const excerpt = "不相关的内容";
		const ranges = recoverExportFontMarkRanges({
			doc,
			sectionIndex: 0,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学" }],
			resolveSectionIndex: buildSectionResolver({
				[HIGHLIGHT_CFI]: 0,
				[MARK_CFI]: 0,
			}),
			resolveRangeInDocument: (cfiRange) =>
				cfiRange === HIGHLIGHT_CFI ? rangeFor(doc, "不相关的内容") : null,
		});
		// 划线基线可解析，但标记「经济学」在该节文档中缺失/无法唯一证明 → 键为 null。
		expect(ranges.get(MARK_CFI)).toBeNull();
		const segments = buildExcerptDecorationSegments({
			text: excerpt,
			highlightCfiRange: HIGHLIGHT_CFI,
			marks: [{ cfiRange: MARK_CFI, text: "经济学", color: "red" }],
			resolveRange: (cfiRange) => ranges.get(cfiRange) ?? null,
		});
		expect(segments).toEqual([]);
		expect(decorateExcerptText(excerpt, segments)).toBe("不相关的内容");
	});
});