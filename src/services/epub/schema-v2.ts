/**
 * Weave 数据 schema v2 —— 书籍聚合单元（BookAggregate）目标结构
 *
 * 设计目标：
 * - 全部数据收敛到 weave-data.json 单一文件
 * - 书是聚合根：books[bookId] 承载该书的一切（元数据 / 阅读状态 / 书签 / 高亮 / 摘录 / 每书 UI）
 * - 不做数据兼容与迁移，从 schema v2 起以本结构为唯一权威
 *
 * @module services/epub/schema-v2
 */

import type {
	BookMetadata,
	EpubLastOpenBookmark,
	EpubReaderSettings,
	Highlight,
	Note,
	ReadingPosition,
	ReadingStats,
} from "./types";
import type { EpubBookmarkRecord } from "./EpubBookmarkService";
import { isFontMarkColorToken, type FontMarkColorToken } from "./font-mark-decoration";

/** schema v2 版本号。 */
export const WEAVE_DATA_SCHEMA_VERSION = 2;

/** 全局 UI 记忆（只留真正的 UI 偏好）。 */
export interface WeaveUiMemory {
	selectionQuickCreateLastFolder?: string;
	/** 书架搜索框记忆（从 v1 uiMemory 延续）。 */
	bookshelfSearchQuery?: string;
	/** 摘录显示/生成偏好（从 v1 excerptSettings 收敛到 UI 记忆）。 */
	excerptSettings?: {
		addCreationTime: boolean;
		chapterLocationFormat: "root" | "leaf" | "full";
		strikethroughDisplayMode: "strikethrough";
		showStrikethroughInSidebar: boolean;
		ideaAutoToNote: boolean;
	};
}

/** 播放清单（收藏夹）。 */
export interface EpubPlaylist {
	id: string;
	name: string;
	bookIds: string[];
}

/**
 * 书籍聚合单元 —— 书的一切数据收敛于此。
 * weave-data.json 的 books 即 Record<bookId, EpubBookAggregate>。
 */
export interface EpubBookAggregate {
	id: string;
	file: EpubBookFileRef;
	meta: BookMetadata;
	reading: EpubBookReading;
	notes: EpubBookNotes;
	ui?: Record<string, unknown>;
	audit: EpubBookAudit;
}

/** 书文件引用（用于定位与去重/改名溯源）。 */
export interface EpubBookFileRef {
	vaultPath: string;
	/** 稳定溯源标识（溯源链接协议依赖，见 EpubLinkService）。 */
	sourceId?: string;
	sourceFingerprint?: string;
	legacyPaths?: string[];
}

export interface EpubBookReading {
	position: ReadingPosition;
	/** 最近一次打开的阅读位置快照（position 的补充：标题/预览/时间）。 */
	lastPosition?: EpubLastOpenBookmark | null;
	stats: ReadingStats;
}

/**
 * notes.highlights 的持久化记录：Highlight 基础上保留运行时标注字段
 * （想法 commentText / 溯源 excerptId / 呈现样式），避免丢失现有功能。
 */
export interface EpubStoredHighlight extends Highlight {
	commentText?: string;
	hasCommentDivider?: boolean;
	excerptId?: string;
	sourceFile?: string;
	sourceRef?: string;
}

/**
 * notes.fontMarks 的持久化记录：字色标记（Font mark）。
 * 独立轻量标注——只染字色，不是划线的变体：不进笔记面板、不触发摘录输出。
 */
export interface EpubStoredFontMark {
	id?: string;
	cfiRange: string;
	color: FontMarkColorToken;
	text?: string;
	createdTime?: number;
	/** 创建时快照的选中词前后上下文（重复词消歧 hint，可选：旧记录无此字段）。 */
	before?: string;
	after?: string;
}

export interface EpubBookNotes {
	bookmarks: EpubBookmarkRecord[];
	highlights: EpubStoredHighlight[];
	excerpts: Note[];
	/** 字色标记（可选：旧聚合无此字段；持久化链路对未知字段原样透传）。 */
	fontMarks?: EpubStoredFontMark[];
}

/**
 * 字色标记的持久化兜底（纯函数）：丢弃缺 cfiRange、颜色 token 非法或非对象的项，
 * 与划线保存路径「无 cfiRange 即丢弃」的行为对齐；坏数据不落盘、读取侧同样清洗。
 */
export function normalizeEpubStoredFontMarks(input: unknown): EpubStoredFontMark[] {
	if (!Array.isArray(input)) {
		return [];
	}
	const marks: EpubStoredFontMark[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			continue;
		}
		const candidate = raw as Partial<EpubStoredFontMark> & Record<string, unknown>;
		const cfiRange = typeof candidate.cfiRange === "string" ? candidate.cfiRange.trim() : "";
		if (!cfiRange || !isFontMarkColorToken(candidate.color)) {
			continue;
		}
		marks.push({
			id: typeof candidate.id === "string" && candidate.id ? candidate.id : undefined,
			cfiRange,
			color: candidate.color,
			text: typeof candidate.text === "string" ? candidate.text : undefined,
			createdTime:
				typeof candidate.createdTime === "number" && Number.isFinite(candidate.createdTime)
					? candidate.createdTime
					: undefined,
			before: typeof candidate.before === "string" && candidate.before ? candidate.before : undefined,
			after: typeof candidate.after === "string" && candidate.after ? candidate.after : undefined,
		});
	}
	return marks;
}

export interface EpubBookAudit {
	createdAt: number;
	updatedAt: number;
}

/** 阅读器设置（已移除 paragraphMode* 等死字段）。 */
export interface EpubReaderSettingsV2 {
	lineHeight: number;
	letterSpacing: number;
	pageMargin: number;
	viewportSidePadding: number;
	theme?: "default";
	widthMode: EpubReaderSettings["widthMode"];
	layoutMode: EpubReaderSettings["layoutMode"];
	flowMode: EpubReaderSettings["flowMode"];
	showScrolledSideNav: boolean;
	footnoteClickAction: EpubReaderSettings["footnoteClickAction"];
	showTopSticker: boolean;
	topStickerLayout: EpubReaderSettings["topStickerLayout"];
}

/** weave-data.json 文档结构（schema v2）。 */
export interface WeaveDataDocumentV2 {
	schemaVersion: typeof WEAVE_DATA_SCHEMA_VERSION;
	updatedAt?: number;
	uiMemory?: WeaveUiMemory;
	readerSettings?: EpubReaderSettingsV2;
	shelfDisplayMode?: string;
	playlists?: EpubPlaylist[];
	books?: Record<string, EpubBookAggregate>;
	/** 通用 vault 级键值（搜索历史等 UI 记忆，v1 highlights 分区收敛于此）。 */
	vaultLocalStorage?: Record<string, string>;
}