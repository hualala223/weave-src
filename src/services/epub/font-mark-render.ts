/**
 * 字色标记（Font mark）共用纯函数模块：书内渲染辅助 + 三路共用的 Range 找回。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md、
 * docs/specs/font-mark-resolution-recovery.md。
 * - 书内渲染走 CSS Custom Highlight API：把标记 Range 注册进章节 iframe 的
 *   `CSS.highlights`，注册名固定为 weave-fontmark-<token>；
 * - 着色样式经既有章节 head 注入通道下发独立 <style data-weave-fontmark-style>，
 *   浅色为基线、深色由 [data-weave-host-scheme="dark"] 覆盖，色值一律取
 *   resolveFontMarkBookTint（与导出 hex 共用单一事实来源）；
 * - 样式声明带 !important：章节样式的深色文本覆盖对元素 color 使用 !important，
 *   而 ::highlight() 普通声明在 css-highlight-api 级联中低于元素 !important 声明，
 *   只有同级的 highlight 重要声明能压过它（否则深色主题下字色不可见）。
 *
 * 找回（recoverFontMarkRange）是书内渲染、摘录导出、点击命中三路共用的
 * 单一事实来源：CFI 锚解析失败时，三路用同一套规则找回标记 Range，不再出现
 * 「渲染侧有找回、导出/点击侧没有」的不对称（票 08 修复对象）。
 *
 * 任何失败都不抛异常：字色只是增强，渲染/导出/点击永不因它阻塞。
 */

import {
	FONT_MARK_COLOR_TOKENS,
	resolveFontMarkBookTint,
	type FontMarkColorToken,
} from "./font-mark-decoration";
import { resolvedRangeCoversHighlightText } from "./highlight/highlight-identity";
import type { ReaderFontMark } from "./reader-engine-types";

/** 章节 iframe 高亮注册表中字色标记的注册名前缀。 */
export const FONT_MARK_HIGHLIGHT_PREFIX = "weave-fontmark-";

export function getFontMarkHighlightName(color: FontMarkColorToken): string {
	return `${FONT_MARK_HIGHLIGHT_PREFIX}${color}`;
}

/** 生成注入章节 head 的 ::highlight 样式（静态内容：浅色基线 + 深色 scheme 覆盖）。 */
export function buildFontMarkHighlightCss(): string {
	const lines: string[] = [
		"/* 字色标记（Font mark）：Custom Highlight API 着色，不修改内容 DOM。 */",
	];
	for (const token of FONT_MARK_COLOR_TOKENS) {
		const name = getFontMarkHighlightName(token);
		// 同步声明 -webkit-text-fill-color：章节深色样式对元素以 !important 固定
		// text-fill-color，若不覆盖，字色会被填充色盖回正文色。
		lines.push(
			`::highlight(${name}) {`,
			`\tcolor: ${resolveFontMarkBookTint(token, "light")} !important;`,
			`\t-webkit-text-fill-color: ${resolveFontMarkBookTint(token, "light")} !important;`,
			"}",
		);
	}
	for (const token of FONT_MARK_COLOR_TOKENS) {
		const name = getFontMarkHighlightName(token);
		lines.push(
			`[data-weave-host-scheme="dark"] ::highlight(${name}) {`,
			`\tcolor: ${resolveFontMarkBookTint(token, "dark")} !important;`,
			`\t-webkit-text-fill-color: ${resolveFontMarkBookTint(token, "dark")} !important;`,
			"}",
		);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * 把字色标记按节索引分组（纯函数，节解析以回调注入便于单测）。
 * 解析不出节索引的标记**不再无痕丢弃**：结果同时暴露 dropped 集合，
 * 供上层落日志定位（书内渲染静默失效的排查入口）。渲染跳过语义不变——
 * 未分组标记不渲染，但保存与导出不受影响。
 */
export interface FontMarkGrouping {
	/** 节索引 → 该节下的标记（按输入顺序）。 */
	grouped: Map<number, ReaderFontMark[]>;
	/** 解析不出节索引、本次不渲染的标记（供日志/诊断）。 */
	dropped: ReaderFontMark[];
}

export function groupFontMarksBySectionIndex(
	marks: readonly ReaderFontMark[],
	resolveSectionIndex: (cfiRange: string) => number | null,
): FontMarkGrouping {
	const grouped = new Map<number, ReaderFontMark[]>();
	const dropped: ReaderFontMark[] = [];
	for (const mark of marks) {
		const sectionIndex = resolveSectionIndex(mark.cfiRange);
		if (typeof sectionIndex !== "number" || sectionIndex < 0) {
			dropped.push(mark);
			continue;
		}
		const bucket = grouped.get(sectionIndex);
		if (bucket) {
			bucket.push(mark);
		} else {
			grouped.set(sectionIndex, [mark]);
		}
	}
	return { grouped, dropped };
}

/**
 * 在节文档内按「文本唯一出现」定位短词（2~3 字）的 Range。
 *
 * 背景：CFI 锚解析失败时，parser 的文本引述找回（findRangeByTextQuote）有
 * ≥4 字符门槛——真实书里用户常标 2~3 字的短词（如「经济学」），门槛使它们
 * 在书内渲染中无任何找回手段，只能静默不显示。
 *
 * 安全性：**只认「全节文档中仅出现一次」的短词**。唯一出现意味着该词在这个
 * 节的文本里只有一个位置，把它染上标记色不可能是「错配到别的词」；若出现
 * 多次（同词多段），则无从判断哪个是标记对象，**放弃注册**（宁可漏染，不可错染）。
 * 调用方仍须过 resolvedRangeCoversHighlightText 的文本验证闸。
 *
 * 返回文本节点内可定位的 Range；找不到或出现多次返回 null。任何未知结构
 * 都不抛异常。
 */
export function findUniqueShortWordRangeInSection(
	doc: Document | null,
	word: string,
): Range | null {
	if (!doc) {
		return null;
	}
	const needle = String(word || "").trim();
	if (!needle || needle.length >= 4) {
		return null;
	}
	const root = doc.body ?? doc.documentElement;
	if (!root) {
		return null;
	}
	// 先收集「文本节点拼接坐标」下的全部出现位置（跨节点不拼接——短词几乎
	// 不会跨节点；若跨节点则按未命中保守处理）。
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let firstRange: Range | null = null;
	let occurrenceCount = 0;
	while (walker.nextNode()) {
		const textNode = walker.currentNode as Text;
		const data = textNode.data;
		let index = data.indexOf(needle);
		while (index >= 0) {
			occurrenceCount += 1;
			if (occurrenceCount === 1) {
				const range = doc.createRange();
				range.setStart(textNode, index);
				range.setEnd(textNode, index + needle.length);
				firstRange = range;
			}
			if (occurrenceCount > 1) {
				return null;
			}
			index = data.indexOf(needle, index + 1);
		}
	}
	return occurrenceCount === 1 ? firstRange : null;
}

/**
 * 三路共用（书内渲染 / 摘录导出 / 点击命中）的标记 Range 找回。
 *
 * 迭代层级（spec「任何一步都坚持同节 + 唯一性」，票 08）：
 * 1. CFI 锚精确解析（无 hint）：CFI 证明的唯一位置，文本验证后直接信任——
 *    词的其它出现不影响（唯一性由 CFI 证明，不查节内出现次数）；
 * 2. 同节文本找回（仅当第 1 层失败）：把标记文本作为 hint 交给解析器引述找回。
 *    引述找回钉住的是「节内首个同文位置」，因此**只有该词节内唯一出现才安全**
 *    接受（出现多次 → 放弃，宁可漏染——ac3a3d8 曾修复的同类误染：同章不同段的
 *    「经济学」被钉到另一处同文染绿）。同节证明是 hint 的准入前提：异节标记
 *    若按文本全文搜索，会被钉到本帧首次出现的同文处，造成没标过的词被染色；
 * 3. 节内唯一短词兜底：1~3 字短词、可证明同节时，以「全节唯一出现」找回
 *    （唯一 = 无歧义，染它不可能错配到别的词；出现多次宁可不染）；
 * 4. 兜底出的 Range 再过一次文本验证闸。
 *
 * 解析器由调用方注入（可测），本函数只做找回编排。任何失败都不抛异常。
 */
export interface FontMarkRangeRecoveryInput {
	doc: Document | null;
	sectionIndex: number;
	/** 标记自身解析出的节号；null = 无法证明归属（禁用 textHint 与短词兜底）。 */
	markSection: number | null;
	/** 是否允许「同节 textHint」找回（跨节 rescue 路径关闭，防异节误染）。 */
	allowSectionTextHint: boolean;
	cfiRange: string;
	/** 标记文本；空则不做文本验证、不传 hint、不兜底。 */
	text: string;
	/** 注入的范围解析器（CFI 锚 + 文本引述）。 */
	resolveRangeInDocument: (cfiRange: string, textHint?: string) => Range | null;
}

export function recoverFontMarkRange(input: FontMarkRangeRecoveryInput): Range | null {
	const {
		doc,
		sectionIndex,
		markSection,
		allowSectionTextHint,
		cfiRange,
		text,
		resolveRangeInDocument,
	} = input;
	const sameSectionProven = markSection !== null && markSection === sectionIndex;
	const trimmedText = String(text || "").trim();

	// ① CFI 锚精确解析（无 hint）：CFI 证明的唯一位置，文本验证后直接信任。
	let range: Range | null = null;
	try {
		range = resolveRangeInDocument(cfiRange, undefined);
	} catch {
		range = null;
	}
	if (range && trimmedText && !resolvedRangeCoversHighlightText(range, text)) {
		range = null;
	}

	// ② 同节文本找回（仅当①失败）：引述找回钉的是「节内首个同文位置」——
	// 该词节内唯一出现才接受（唯一性闸；多出现宁可漏染，防错染到另一处同文）。
	if (!range && trimmedText && sameSectionProven && allowSectionTextHint) {
		try {
			range = resolveRangeInDocument(cfiRange, text);
		} catch {
			range = null;
		}
		if (range && !resolvedRangeCoversHighlightText(range, text)) {
			range = null;
		}
		if (range && countTextOccurrencesInSection(doc, trimmedText) > 1) {
			range = null;
		}
	}

	// ③ 节内唯一短词兜底：仅可证明同节（与 allowSectionTextHint 无关——兜底是
	// 「证明归属 + 唯一性」双闸，跨节 rescue 路径亦可安全使用）。
	if (!range && trimmedText && sameSectionProven && trimmedText.length < 4) {
		try {
			range = findUniqueShortWordRangeInSection(doc, text);
		} catch {
			range = null;
		}
	}

	// 兜底出的 Range 仍须过文本验证闸。
	if (range && trimmedText && !resolvedRangeCoversHighlightText(range, text)) {
		return null;
	}
	return range;
}

/** 节文档中 needle 的出现次数（跨文本节点不拼接，与短词兜底同规；0 = 无/空文档）。 */
function countTextOccurrencesInSection(doc: Document | null, needle: string): number {
	if (!doc || !needle) {
		return 0;
	}
	const root = doc.body ?? doc.documentElement;
	if (!root) {
		return 0;
	}
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let count = 0;
	while (walker.nextNode()) {
		const data = (walker.currentNode as Text).data;
		let index = data.indexOf(needle);
		while (index >= 0) {
			count += 1;
			index = data.indexOf(needle, index + 1);
		}
	}
	return count;
}

/**
 * 导出侧找回编排：把「划线基线 + 候选标记」统一为可查询的 cfiRange → Range 映射。
 *
 * - 划线基线（偏移计算的锚）：节号匹配 + 结构解析，**不传 hint**（摘录是整句，
 *   无需引述找回；划线锚解析失败即整组无色，保持既有语义）；
 * - 每个标记：走三路共用的 recoverFontMarkRange（CFI 锚 → 同节 hint → 节内唯一
 *   短词兜底），解析失败/无法证明归属的标记键为 null——导出装饰编排按严格包含性
 *   跳过它们（宁可漏染，不可错染），其余标记不受影响。
 *
 * 返回含 highlightCfiRange 键的映射，供 buildExcerptDecorationSegments 的
 * resolveRange 直接查询。任何失败都不抛异常。
 */
export interface FontMarkExportRecoveryInput {
	doc: Document | null;
	sectionIndex: number;
	highlightCfiRange: string;
	marks: readonly { cfiRange: string; text?: string }[];
	resolveSectionIndex: (cfiRange: string) => number | null;
	resolveRangeInDocument: (cfiRange: string, textHint?: string) => Range | null;
}

export function recoverExportFontMarkRanges(
	input: FontMarkExportRecoveryInput
): Map<string, Range | null> {
	const {
		doc,
		sectionIndex,
		highlightCfiRange,
		marks,
		resolveSectionIndex,
		resolveRangeInDocument,
	} = input;
	const ranges = new Map<string, Range | null>();
	// 划线基线：节号匹配 + 结构解析（不传 hint）。
	let highlightSection: number | null = null;
	try {
		highlightSection = resolveSectionIndex(highlightCfiRange);
	} catch {
		highlightSection = null;
	}
	if (highlightSection !== null && highlightSection === sectionIndex) {
		try {
			ranges.set(highlightCfiRange, resolveRangeInDocument(highlightCfiRange, undefined));
		} catch {
			ranges.set(highlightCfiRange, null);
		}
	} else {
		ranges.set(highlightCfiRange, null);
	}
	// 候选标记：三路共用找回。
	for (const mark of marks) {
		let markSection: number | null = null;
		try {
			markSection = resolveSectionIndex(mark.cfiRange);
		} catch {
			markSection = null;
		}
		ranges.set(
			mark.cfiRange,
			recoverFontMarkRange({
				doc,
				sectionIndex,
				markSection,
				allowSectionTextHint: true,
				cfiRange: mark.cfiRange,
				text: mark.text || "",
				resolveRangeInDocument,
			})
		);
	}
	return ranges;
}
