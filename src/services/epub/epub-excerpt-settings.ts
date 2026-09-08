import type { EpubStrikethroughDisplayMode } from "./types";

export type EpubChapterLocationFormat = "root" | "leaf" | "full";

export interface EpubExcerptSettings {
	addCreationTime: boolean;
	chapterLocationFormat: EpubChapterLocationFormat;
	strikethroughDisplayMode: EpubStrikethroughDisplayMode;
	showStrikethroughInSidebar: boolean;
	/** 想法入笔记：保存非空想法后自动把摘录块追加到笔记文档末尾。 */
	ideaAutoToNote: boolean;
	/** 摘录面板排序方向：true = 最新摘录在最上（默认），false = 最新摘录在最下。仅影响面板显示，不影响粘贴写入顺序。 */
	newestExcerptOnTop: boolean;
}

export const DEFAULT_EPUB_EXCERPT_SETTINGS: EpubExcerptSettings = {
	addCreationTime: false,
	chapterLocationFormat: "leaf",
	strikethroughDisplayMode: "strikethrough",
	showStrikethroughInSidebar: false,
	ideaAutoToNote: true,
	newestExcerptOnTop: true,
};
