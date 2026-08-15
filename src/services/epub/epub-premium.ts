import { App } from "obsidian";
import { EPUB_FEATURE_IDS } from "../../config/epub-feature-tier";
import { isFreeBookFormat } from "./book-format";

export interface EpubFeatureTierPreviewItem {
	title: string;
	description: string;
	featureId?: string;
}

export function getEpubFeatureTierPreview(): {
	freeFeatures: EpubFeatureTierPreviewItem[];
	premiumFeatures: EpubFeatureTierPreviewItem[];
} {
	return {
		freeFeatures: [],
		premiumFeatures: [],
	};
}

export function getEpubPremiumFeaturePreviewContent(featureId: string): {
	title: string;
	description: string;
	freeFeatures: EpubFeatureTierPreviewItem[];
	premiumFeatures: EpubFeatureTierPreviewItem[];
} {
	return {
		title: featureId,
		description: "",
		freeFeatures: [],
		premiumFeatures: [],
	};
}

export function canUseEpubPremiumFeature(_app: App, _featureId: string): boolean {
	/* 免费开放：所有功能无需授权 */
	return true;
}

export function canOpenBookWithCurrentLicense(_filePath: string): boolean {
	/* 免费开放 */
	return true;
}

export function canOpenEpubFile(_app: App, filePath: string): boolean {
	return isFreeBookFormat(filePath);
}

export function canUseEpubReadingProgress(_app: App): boolean {
	return true;
}

export function canUseEpubReadingReference(_app: App): boolean {
	return true;
}

export function canUseEpubParagraphMode(_app: App): boolean {
	return true;
}

export function canUseEpubExcerptNotes(_app: App): boolean {
	return true;
}

export function canUseEpubStyledExcerpts(_app: App): boolean {
	return true;
}

export function canUseEpubSourceLocation(_app: App): boolean {
	return true;
}

/** Cross-document excerpt source tracing (book ↔ notes/cards), all supported formats. */
export function ensureBookSourceLocationAccess(_app: App, _noticeMessage?: string): boolean {
	return true;
}

export function canUseEpubCanvasExcerpts(_app: App): boolean {
	return true;
}

export function canUseEpubFootnotePreview(_app: App): boolean {
	return true;
}

export function canUseEpubChapterExport(_app: App): boolean {
	return true;
}

export function requestEpubPremiumFeaturePreview(_app: App, _featureId: string): void {
	/* 免费开放：无预览弹层 */
}

export function ensureEpubFileAccess(_app: App, _filePath: string, _noticeMessage?: string): boolean {
	return true;
}

export function ensureEpubPremiumFeature(
	_app: App,
	_featureId: string,
	_noticeMessage?: string
): boolean {
	return true;
}

export { EPUB_FEATURE_IDS as PREMIUM_FEATURES };
