import type { EpubStrikethroughDisplayMode } from "./types";

export type EpubChapterLocationFormat = "root" | "leaf" | "full";

export interface EpubExcerptSettings {
	addCreationTime: boolean;
	chapterLocationFormat: EpubChapterLocationFormat;
	strikethroughDisplayMode: EpubStrikethroughDisplayMode;
	showStrikethroughInSidebar: boolean;
}

export const DEFAULT_EPUB_EXCERPT_SETTINGS: EpubExcerptSettings = {
	addCreationTime: false,
	chapterLocationFormat: "leaf",
	strikethroughDisplayMode: "strikethrough",
	showStrikethroughInSidebar: false,
};
