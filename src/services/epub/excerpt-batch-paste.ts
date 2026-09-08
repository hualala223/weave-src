/**
 * 摘录面板「粘贴所选摘录到笔记」的纯逻辑（票01-03 的单一测试缝）。
 *
 * 职责边界：
 * - 侧栏摘录面板按 createdTime 降序显示（最新在上），而粘贴到笔记时要求
 *   最早摘录在最上（与显示顺序相反）——排序在本模块内完成；
 * - 逐条按「划线自动插入」同款格式构建摘录块（深链/章节标签/样式位/时间戳），
 *   带想法的摘录内联渲染想法条目；
 * - 空块丢弃、去尾换行、块间以空行分隔拼接为一次插入的内容。
 *
 * 不含 Obsidian 依赖：摘录块构建器（EpubLinkService.buildQuoteBlock）以参数注入，
 * 想法条目渲染复用 idea-note-doc 的纯函数。
 */

import type { EpubHighlightStyle } from "./types";
import { renderIdeaQuoteBlock, type IdeaEntryInput } from "./idea-note-doc";
import { formatExcerptEntryTimestamp, formatExcerptTimestamp } from "./epub-time-format";

/** 批量粘贴的单个摘录条目（宿主已完成字色装饰与章节标签解析后的形态）。 */
export interface ExcerptPasteBlockItem {
	cfiRange: string;
	/** 已装饰的引用原文（字色标记保留）。 */
	text: string;
	color?: string;
	chapterIndex?: number;
	/** 宿主按「章节标签格式」设置解析的章节标签；缺失时由构建器兜底。 */
	chapterLabel?: string;
	excerptId?: string;
	createdTime?: number;
	/** 划线类型键（highlight/underline/strikethrough/wavy），仅样式类输出样式位。 */
	noteTypeKey?: string;
	commentText?: string;
	hasCommentDivider?: boolean;
	/**
	 * 条目 key（宿主口径 = cfiRange）：结果回传实际构建成功的 key 集合，
	 * 供宿主只对真正写入笔记的条目回写已粘贴标记；缺失 key 的条目不参与回写。
	 */
	key?: string;
}

export interface ExcerptPasteBuildContext {
	filePath: string;
	sourceId?: string;
	/** 目标笔记文档路径（深链相对其解析，与自动插入一致）。 */
	sourcePath?: string;
	addCreationTime: boolean;
	chapterLabelMaxLength: number;
	/** 摘录块构建器（注入 EpubLinkService.buildQuoteBlock 或测试伪实现）。 */
	buildQuoteBlock: (
		filePath: string,
		cfi: string,
		text: string,
		chapterIndex?: number,
		color?: string,
		chapterTitle?: string,
		timestamp?: string,
		sourcePath?: string,
		sourceId?: string,
		excerptId?: string,
		style?: EpubHighlightStyle,
		chapterLabelMaxLength?: number
	) => string;
}

/** 粘贴顺序：按 createdTime 升序（最早摘录在最上）；同时间戳保持原顺序（稳定排序）。 */
export function sortExcerptsForPaste<T extends { createdTime?: number }>(items: T[]): T[] {
	return [...items].sort((left, right) => (left.createdTime || 0) - (right.createdTime || 0));
}

/** 仅样式类划线输出 callout 样式位（普通高亮不输出样式 token）。 */
export function resolveExcerptPasteStyle(noteTypeKey?: string): EpubHighlightStyle | undefined {
	const key = String(noteTypeKey || "").trim().toLowerCase();
	if (key === "underline" || key === "strikethrough" || key === "wavy") {
		return key;
	}
	return undefined;
}

/**
 * 构建单条摘录块：缺失 cfiRange 或引用文本的条目返回空串（不阻塞整批）；
 * 时间戳只在该摘录有创建时间且「添加时间」开启时输出（原始创建时间，非粘贴时刻）。
 * 引用原文与 cfiRange 原样传给构建器（与划线自动插入一致，不裁剪首尾空白）。
 */
function buildSingleExcerptPasteBlock(
	item: ExcerptPasteBlockItem,
	context: ExcerptPasteBuildContext
): string {
	const cfi = String(item.cfiRange || "");
	const text = String(item.text || "");
	if (!cfi.trim() || !text.trim()) {
		return "";
	}
	const timestamp =
		context.addCreationTime && item.createdTime
			? formatExcerptTimestamp(new Date(item.createdTime))
			: undefined;
	const quoteBlock = context.buildQuoteBlock(
		context.filePath,
		cfi,
		text,
		item.chapterIndex,
		item.color,
		item.chapterLabel,
		timestamp,
		context.sourcePath,
		context.sourceId,
		item.excerptId,
		resolveExcerptPasteStyle(item.noteTypeKey),
		context.chapterLabelMaxLength
	);
	if (item.hasCommentDivider && String(item.commentText || "").trim()) {
		const entry: IdeaEntryInput = {
			text: String(item.commentText || ""),
			// 面板不单独记录想法写入时刻：条目时间戳取摘录原始创建时间，与块后缀时间一致。
			timestamp: item.createdTime ? formatExcerptEntryTimestamp(new Date(item.createdTime)) : undefined,
		};
		return renderIdeaQuoteBlock(quoteBlock, [entry]);
	}
	return quoteBlock;
}

/**
 * 批量粘贴主入口：把摘录列表按最早在前构建为可直接插入笔记末尾的完整文本
 * （多条一次写入、块间空行分隔，与「划线自动插入逐次追加到末尾」的既有排版一致）。
 *
 * 单条构建的任何异常（数据缺失、构建器抛错）都不阻塞整批：跳过失败条目继续
 * 其余条目（用户故事 21）。返回 { content, count }：content 为待插入文本，
 * count 为实际构建出的摘录块数（供宿主提示「已粘贴 N 条」时如实标注）。
 */
export function buildExcerptPasteBlocks(
	items: ExcerptPasteBlockItem[],
	context: ExcerptPasteBuildContext
): { content: string; count: number; keys: string[] } {
	const blocks: { block: string; key?: string }[] = [];
	for (const item of sortExcerptsForPaste(items)) {
		try {
			blocks.push({ block: buildSingleExcerptPasteBlock(item, context), key: item.key });
		} catch {
			// 单条构建异常（如注入的块构建器抛错）不阻塞整批：跳过该条继续。
		}
	}
	const content = joinExcerptPasteBlocks(blocks.map((entry) => entry.block));
	const keys: string[] = [];
	for (const entry of blocks) {
		if (entry.block.trim().length > 0 && entry.key) {
			keys.push(entry.key);
		}
	}
	return { content, count: blocks.filter((entry) => entry.block.trim().length > 0).length, keys };
}

/**
 * 把逐条构建好的摘录块拼接为一次插入的内容：
 * 每条块去掉末尾换行（buildQuoteBlock/renderIdeaQuoteBlock 自带收尾换行），
 * 空块丢弃，块与块之间以空行（\n\n）分隔。
 */
export function joinExcerptPasteBlocks(blocks: string[]): string {
	return blocks
		.map((block) => String(block || '').replace(/\n+$/, ''))
		.filter((block) => block.trim().length > 0)
		.join('\n\n');
}