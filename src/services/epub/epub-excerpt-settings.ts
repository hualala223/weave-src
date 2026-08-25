import type { EpubStrikethroughDisplayMode } from "./types";

export type EpubChapterLocationFormat = "root" | "leaf" | "full";

export interface EpubExcerptSettings {
	addCreationTime: boolean;
	chapterLocationFormat: EpubChapterLocationFormat;
	strikethroughDisplayMode: EpubStrikethroughDisplayMode;
	showStrikethroughInSidebar: boolean;
	/** 想法入笔记：保存非空想法后自动把摘录块追加到笔记文档末尾。 */
	ideaAutoToNote: boolean;
}

export const DEFAULT_EPUB_EXCERPT_SETTINGS: EpubExcerptSettings = {
	addCreationTime: false,
	chapterLocationFormat: "leaf",
	strikethroughDisplayMode: "strikethrough",
	showStrikethroughInSidebar: false,
	ideaAutoToNote: true,
};
