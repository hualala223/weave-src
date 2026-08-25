/**
 * 字色标记（Font mark）书内渲染辅助纯函数模块。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md。
 * - 书内渲染走 CSS Custom Highlight API：把标记 Range 注册进章节 iframe 的
 *   `CSS.highlights`，注册名固定为 weave-fontmark-<token>；
 * - 着色样式经既有章节 head 注入通道下发独立 <style data-weave-fontmark-style>，
 *   浅色为基线、深色由 [data-weave-host-scheme="dark"] 覆盖，色值一律取
 *   resolveFontMarkBookTint（与导出 hex 共用单一事实来源）；
 * - 样式声明带 !important：章节样式的深色文本覆盖对元素 color 使用 !important，
 *   而 ::highlight() 普通声明在 css-highlight-api 级联中低于元素 !important 声明，
 *   只有同级的 highlight 重要声明能压过它（否则深色主题下字色不可见）。
 *
 * 任何失败都不抛异常：字色只是增强，渲染永不因它阻塞阅读。
 */

import {
	FONT_MARK_COLOR_TOKENS,
	resolveFontMarkBookTint,
	type FontMarkColorToken,
} from "./font-mark-decoration";
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
