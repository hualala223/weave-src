export { FoliateReaderService } from "./FoliateReaderService";
export {
	DEFAULT_EPUB_READER_ENGINE,
	createEpubReaderEngine,
} from "./reader-engine-factory";
export type {
	EpubReaderEngine,
	EpubReaderEngineType,
	FlashStyle,
	HighlightSourceLocator,
	HighlightClickInfo,
	NavigateAndHighlightOptions,
	ReaderHighlightPresentation,
	ReaderNavigateOptions,
	ReaderAppearanceOptions,
	ReaderFootnotePreviewInfo,
	ReaderFrame,
	ReaderHighlight,
	ReaderHighlightInput,
	ReaderParagraph,
	ReaderParagraphLocation,
	ReaderParagraphSelectionResolution,
	ReaderRandomParagraphPick,
	ReaderRenderOptions,
	ReaderSelectionChange,
	ReaderViewportGeometry,
} from "./reader-engine-types";
export { EpubStorageService, flushEpubStoragePendingProgress } from "./EpubStorageService";
export { flushEpubPendingProgress, getEpubStorageService, resetEpubStorageServiceCache } from "./epub-storage-access";
export {
	BOOKSHELF_GRID_PAINT_OPTIMIZATION_THRESHOLD,
	BOOKSHELF_LIST_VIRTUAL_SCROLL_THRESHOLD,
	shouldUseBookshelfGridPaintOptimization,
	shouldUseBookshelfListVirtualScroll,
} from "./bookshelf-display-performance";
export type {
	EpubBookshelfSettings,
	EpubBookshelfIndexEntry,
	EpubBookshelfMembershipEntry,
	EpubScanIndexEntry,
} from "./EpubStorageService";
export {
	DEFAULT_EPUB_BOOKSHELF_SETTINGS,
} from "./EpubStorageService";
export type { EpubExcerptSettings } from "./epub-excerpt-settings";
export { DEFAULT_EPUB_EXCERPT_SETTINGS } from "./epub-excerpt-settings";
export {
	registerEpubHost,
	resolveEpubHost,
	resolveEpubWeaveOfficialAPI,
	unregisterEpubHost,
} from "./epub-host";
export type {
	EpubHostCapabilities,
	EpubWeaveExcerptRemovalMode,
	EpubWeaveOfficialAPI,
	EpubWeaveOfficialAPIInfo,
	EpubWeaveRemoveExcerptInput,
	EpubWeaveRemoveExcerptResult,
} from "./epub-host";
export {
	EPUB_RUNTIME,
	getEpubRuntime,
	isLegacyEpubProtocolName,
	isSupportedEpubProtocolName,
} from "./epub-runtime";
export { getEpubHighlightViewSnapshotService } from "./epub-highlight-view-snapshot-access";
export { EpubHighlightViewSnapshotService } from "./EpubHighlightViewSnapshotService";
export type {
	EpubDisplayHighlight,
	EpubHighlightRenderSnapshot,
	EpubHighlightSnapshotContextInput,
	EpubHighlightSnapshotRevalidateInput,
} from "./EpubHighlightViewSnapshotService";
export {
	EpubBookmarkService,
	type EpubBookmarkReadingState,
	DEFAULT_EPUB_BOOKMARK_FOLDER,
	normalizeEpubBookmarkFolderPath,
} from "./EpubBookmarkService";
export { EpubLinkService } from "./EpubLinkService";
export { EpubLocationMigrationService } from "./EpubLocationMigrationService";
export {
	canOpenBookWithCurrentLicense,
	canUseEpubCanvasExcerpts,
	canOpenEpubFile,
	canUseEpubExcerptNotes,
	canUseEpubFootnotePreview,
	canUseEpubParagraphMode,
	getEpubFeatureTierPreview,
	getEpubPremiumFeaturePreviewContent,
	canUseEpubPremiumFeature,
	canUseEpubReadingProgress,
	canUseEpubReadingReference,
	canUseEpubSourceLocation,
	canUseEpubStyledExcerpts,
	ensureBookSourceLocationAccess,
	ensureEpubFileAccess,
	ensureEpubPremiumFeature,
	requestEpubPremiumFeaturePreview,
	PREMIUM_FEATURES,
} from "./epub-premium";
export * from "./types";
export {
	createReaderTapZoneController,
	createTapBurstTracker,
	resolveTapZone,
	TAP_FLIP_GRACE_MS,
	TAP_TRIPLE_WINDOW_MS,
	TAP_ZONE_PREV_RATIO,
	TAP_LONG_PRESS_MS,
	TAP_MOVE_TOLERANCE_PX,
	TAP_RECENT_SELECTION_MS,
	TAP_INTERACTIVE_SELECTOR,
	type ReaderTapEvent,
	type ReaderTapZone,
	type TapBurstTracker,
} from "./reader-tap-zones";
export {
	isBookCompleted,
	resolveDisplayProgress,
	resolveBookshelfReadingStatus,
	type BookshelfReadingStatus,
} from "./book-progress";
