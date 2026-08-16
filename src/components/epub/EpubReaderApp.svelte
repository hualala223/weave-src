<script lang="ts">
        import type { App, WorkspaceLeaf, TAbstractFile, EventRef } from 'obsidian';
        import { setIcon, MarkdownView, Notice, Menu, TFile, Platform, normalizePath } from 'obsidian';
	import { onMount, untrack } from 'svelte';
	import EpubReaderView from './EpubReaderView.svelte';
	import BookshelfView from './BookshelfView.svelte';
	import BottomNav from './BottomNav.svelte';
	import EpubLoadingState from './EpubLoadingState.svelte';
	import SelectionToolbar from './SelectionToolbar.svelte';
	import EpubHighlightToolbar from './EpubHighlightToolbar.svelte';
	import EpubCommentEditorPopover from './EpubCommentEditorPopover.svelte';
	import EpubFootnotePreviewPopover from './EpubFootnotePreviewPopover.svelte';
	import { createEpubReaderEngine, createTapBurstTracker, DEFAULT_EPUB_EXCERPT_SETTINGS, EPUB_RUNTIME, EpubLinkService, EpubLocationMigrationService, flushEpubPendingProgress, getEpubHighlightViewSnapshotService, getEpubStorageService, isBookCompleted, resolveDisplayProgress, TAP_FLIP_GRACE_MS, TAP_TRIPLE_WINDOW_MS } from '../../services/epub';
	import type { EpubBook, EpubExcerptSettings, EpubFlowMode, EpubHighlightStyle, EpubLayoutMode, EpubReaderEngine, EpubReaderSettings, EpubReadingReferencePoint, HighlightClickInfo, PaginationInfo, ReaderFootnotePreviewInfo, ReaderHighlight, ReaderTapEvent, ReadingPosition } from '../../services/epub';
	import { EpubBookmarkService } from '../../services/epub/EpubBookmarkService';
	import {
		getDefaultEpubReaderSettings,
		normalizeEpubReaderSettingsForDevice,
		type EpubReaderSettingsDeviceKind,
	} from '../../services/epub/reader-settings';
	import { vaultStorage } from '../../utils/vault-local-storage';
	import {
		BookLoadCancelledError,
		buildBookLoadSlowWarningMessage,
		runBookLoadSession,
	} from '../../services/epub/book-load-session';
	import {
		canReuseExistingBook,
		resolveBookLoadRestoredPosition,
	} from '../../services/epub/epub-reader-book-load-helpers';
	import {
		getBookshelfDisplayModeOptions,
		getBookshelfDisplayModeOption,
		normalizeBookshelfDisplayMode,
		DEFAULT_BOOKSHELF_DISPLAY_MODE,
		type BookshelfDisplayMode,
	} from '../../services/epub/bookshelf-display-mode';
	import {
		createDebouncedBookshelfProgressChangedNotifier,
		dispatchEpubBookshelfDataChanged,
		dispatchEpubBookshelfRefreshRequest,
	} from '../../services/epub/bookshelf-data-events';
	import { epubActiveDocumentStore } from '../../stores/epub-active-document-store';
	import { logger } from '../../utils/logger';
	import { getOpenEpubFilePath, pathsReferToSameOpenBook } from '../../utils/epub-leaf-utils';
	import { showObsidianChoice, showObsidianConfirm } from '../../utils/obsidian-confirm';
	import { UnifiedThemeManager } from '../../utils/theme-detection';
	import { getSourceLocateOverlayService } from '../../services/ui/SourceLocateOverlayService';
	import type { BookLocateIntent, PendingLocateState } from '../../services/navigation/navigation-intent';
	import { getBookSessionManager } from '../../services/epub/session/book-session-manager-access';
	import type { BookSession } from '../../services/epub/session/BookSessionManager';
	import {
		getReaderHighlightIdentityKey,
		hasReaderHighlightPresentationChanged,
		mergeReaderHighlightsByIdentity,
	} from './useEpubHighlights';
	import {
		buildEpubDisplayHighlightSelectionKey,
		type EpubDisplayHighlight,
	} from '../../services/epub/EpubHighlightViewSnapshotService';
	import { createEpubNavigationController } from './useEpubNavigation';
	import { resolveReadingViewportLockTarget } from '../../utils/mobile-reading-viewport-lock';
	import { domInstanceOf } from '../../utils/dom-instance-of';
	import { shouldDismissToolbarOnPointerDown } from './toolbar-positioning';
	import { generateBlockID } from '../../services/identifier/WeaveIDGenerator';
	import {
		normalizeContinuousReadingPositionAutoSaveEnabled,
		normalizeContinuousReadingPositionAutoSavePages,
	} from '../../config/reading-position-auto-save';
	import { CURRENT_PLUGIN_ID } from '../../config/plugin-runtime';
	import '../../styles/epub/epub-reader.css';

	interface Props {
		app: App;
		filePath: string;
		pendingLocate?: PendingLocateState | null;
		pendingCfi?: string;
		pendingText?: string;
		autoInsertEnabled?: boolean;
		getLastActiveMarkdownLeaf?: () => WorkspaceLeaf | null;
		onTitleChange?: (title: string) => void;
		onChapterTitleChange?: (title: string) => void;
		onReadingReferencePointChange?: (point: EpubReadingReferencePoint | null) => void;
		onReadingPositionAutoSaveChange?: () => void;
		onReaderSettingsLoaded?: (settings: EpubReaderSettings) => void;
		onBackFromBookshelf?: () => void | Promise<void>;
		onCancelBookLoad?: () => void | Promise<void>;
		onActionsReady?: (actions: {
			setAutoInsert: (enabled: boolean) => void;
			setLayoutMode: (mode: EpubLayoutMode) => void;
			setFlowMode: (mode: EpubFlowMode) => void;
			openTypographyPanel: () => void;
			getReaderSettings: () => EpubReaderSettings;
			updateReaderSettings: (patch: Partial<EpubReaderSettings>) => Promise<void>;
			navigateToCfi: (cfi: string, linkTextHint?: string) => void;
				addBookmark: () => Promise<void>;
			canUseReadingProgress?: () => boolean;
			canUseReadingReference?: () => boolean;
			canUseExcerptNotes?: () => boolean;
			canUseStyledExcerpts?: () => boolean;
			canUseFootnotePreview?: () => boolean;
			saveReadingReferencePoint?: () => Promise<void>;
			openReadingPositionMenu?: (event: MouseEvent | KeyboardEvent) => void;
			getReadingPositionAutoSaveEnabled?: () => boolean;
			setReadingPositionAutoSaveEnabled?: (enabled: boolean) => Promise<boolean>;
			getExcerptSettings: () => EpubExcerptSettings;
			updateExcerptSettings: (patch: Partial<EpubExcerptSettings>) => Promise<void>;
			prevPage: () => void | Promise<void>;
			nextPage: () => void | Promise<void>;
		}) => void;
		onSwitchBook?: (filePath: string) => void;
	}

	let { 
		app, 
		filePath, 
		pendingLocate = null,
		pendingCfi = '', 
		pendingText = '', 
		autoInsertEnabled: initialAutoInsert = false, 
		getLastActiveMarkdownLeaf, 
		onTitleChange, 
		onChapterTitleChange,
		onReadingReferencePointChange,
		onReadingPositionAutoSaveChange,
		onReaderSettingsLoaded, 
		onBackFromBookshelf,
		onCancelBookLoad,
		onActionsReady, 
		onSwitchBook
	}: Props = $props();
	function getDefaultReaderLineHeight(): number {
		return getDefaultReaderSettings().lineHeight;
	}

	function getDefaultReaderPageMargin(): number {
		return getDefaultReaderSettings().pageMargin;
	}

	function getDefaultReaderWidthMode(): EpubReaderSettings['widthMode'] {
		return getDefaultReaderSettings().widthMode;
	}

	function getDefaultReaderFlowMode(): EpubReaderSettings['flowMode'] {
		return getDefaultReaderSettings().flowMode;
	}

	function isDesktopScrolledSideNavVisible(): boolean {
		return settings.flowMode === 'scrolled' && settings.showScrolledSideNav && !isMobileReader();
	}

	function getReaderRootStyle(): string {
		const effectiveLineHeight = typeof settings.lineHeight === 'number' && settings.lineHeight > 0
			? settings.lineHeight
			: getDefaultReaderLineHeight();
		const pagedSafeInset = `${(effectiveLineHeight * 0.5).toFixed(3)}em`;
		// 底部留出拇指区：顶部 0.5 行高 + 2.8em 舒适内边距
		const pagedSafeBottom = `calc(${pagedSafeInset} + 2.8em)`;
		return `--epub-line-height: ${effectiveLineHeight}; --epub-paged-safe-top: ${pagedSafeInset}; --epub-paged-safe-bottom: ${pagedSafeBottom};`;
	}

	let readerService: EpubReaderEngine = untrack(() => createEpubReaderEngine(app));
	let storageService = untrack(() => getEpubStorageService(app));
	let bookmarkService = untrack(() => new EpubBookmarkService(app));
	let highlightViewSnapshotService = untrack(() => getEpubHighlightViewSnapshotService(app));
	let locationMigrationService = untrack(() => new EpubLocationMigrationService(app, storageService, readerService));
	let linkService = untrack(() => new EpubLinkService(app));

	let book = $state<EpubBook | null>(null);
	let loading = $state(true);
	let bookLoadSlowWarning = $state(false);
	let errorMsg = $state('');
	let readingProgress = $state(0);
	let paginationInfo = $state<PaginationInfo>({ currentPage: 0, totalPages: 0 });
	let mobileFullscreen = $state(false);
	let tapTurnTimer: number | null = null;
	let tapTurnZone: 'prev' | 'next' | null = null;
	const tapBurstTracker = createTapBurstTracker({ windowMs: TAP_TRIPLE_WINDOW_MS });
	let currentChapterIndex = $state(0);
	let showScrolledChapterNavActions = $state(false);
	let readerVersion = $state(0);
	let autoInsert = $state(untrack(() => initialAutoInsert));

	let transientStatusText = $state('');
	let readingReferencePoint = $state<EpubReadingReferencePoint | null>(null);
	let sessionReadingStartPercent = $state<number | null>(null);
	let bookCompletionPromptOpen = false;
	let bookCompletionPromptDismissedBookId = '';
	let rootEl = $state<HTMLDivElement | null>(null);
	let viewportEl = $state<HTMLDivElement | null>(null);
	let readingViewportLockEl = $derived(resolveReadingViewportLockTarget(rootEl));
	let typographyPopoverOpen = $state(false);
	let readerReady = $state(false);
	let scrolledNavSyncFrame = 0;
	let scrolledNavResizeObserver: ResizeObserver | null = null;
	let highlightToolbarInfo = $state<HighlightClickInfo | null>(null);
	let commentEditorInfo = $state<HighlightClickInfo | null>(null);
	let footnotePreviewInfo = $state<ReaderFootnotePreviewInfo | null>(null);
	let commentEditorDraft = $state('');
	let commentEditorSaving = $state(false);
	let highlightDeleting = $state(false);
	const SCROLLED_NAV_FRAME_INSET_VAR = '--epub-scrolled-side-nav-frame-inset-end';
	const SCROLLED_NAV_SCROLLBAR_VAR = '--epub-scrolled-side-nav-scrollbar-width';
	let excerptSettings = $state<EpubExcerptSettings>({
		...DEFAULT_EPUB_EXCERPT_SETTINGS,
	});
	let excerptSettingsLoaded = $state(false);
	let excerptSettingsReady: Promise<void> = Promise.resolve();
	let trackedHighlightSourceFiles = new Set<string>();
	let bookSession = untrack(() => getBookSessionManager(app).acquire(filePath));
	let vaultEventRefs: EventRef[] = [];
	let pendingLoadedHighlights: ReaderHighlight[] | null = null;
	let highlightReloadToken = 0;
	let highlightReloading = $state(false);
	let annotationRevision = $state(0);
	let bookmarkRevision = $state(0);
	let migratedLocationBookIds = new Set<string>();
	let migratingLocationBookId: string | null = null;
	let scrolledChapterEndCleanup: (() => void) | null = null;
	const sourceLocateOverlay = getSourceLocateOverlayService();
	let hasPendingBookLocate = $state(false);
	const epubNavigation = untrack(() =>
		createEpubNavigationController({
			getReaderReady: () => readerReady,
			getReaderService: () => readerService,
			getSourceLocateOverlay: () => sourceLocateOverlay,
			getLocateOverlayLabel: () => '定位到溯源位置',
			onPendingChange: (hasPending) => {
				hasPendingBookLocate = hasPending;
			},
		})
	);
	let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;
	let deferredHighlightReloadTimer: ReturnType<typeof setTimeout> | null = null;
	let componentDisposed = false;
	let activeBookLoadToken = 0;
	let readerStoreSyncTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingReaderStorePatch: Record<string, unknown> = {};
	const READER_STORE_SYNC_MS = 350;

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				// /skip innerHTML is used to clear the trusted icon container before setIcon rerenders it
				node.replaceChildren();
				setIcon(node, newName);
			}
		};
	}

	let settings = $state<EpubReaderSettings>({
		lineHeight: getDefaultReaderLineHeight(),
		letterSpacing: 0,
		pageMargin: getDefaultReaderPageMargin(),
		viewportSidePadding: Platform.isMobile ? 18 : 24,
		theme: 'default',
		widthMode: getDefaultReaderWidthMode(),
		layoutMode: 'paginated',
		flowMode: getDefaultReaderFlowMode(),
		showScrolledSideNav: true,
		footnoteClickAction: 'preview',
		paragraphModeEnabled: false,
	});

	let hostTheme = $state<'light' | 'dark'>(
		untrack(() => (UnifiedThemeManager.getInstance().isDarkMode() ? 'dark' : 'light'))
	);

	function isMobileReader(): boolean {
		return Platform.isMobile;
	}

	function getReaderDeviceKind(): EpubReaderSettingsDeviceKind {
		return isMobileReader() ? 'mobile' : 'desktop';
	}

	function getDefaultReaderSettings(): EpubReaderSettings {
		return getDefaultEpubReaderSettings(getReaderDeviceKind());
	}

	function hasReadingProgressCapability(): boolean {
		return true;
	}

	function hasReadingReferenceCapability(): boolean {
		return true;
	}

	function hasExcerptNotesCapability(): boolean {
		return true;
	}

	function hasStyledExcerptCapability(): boolean {
		return true;
	}

	function hasSourceLocationCapability(): boolean {
		return true;
	}

	function hasFootnotePreviewCapability(): boolean {
		return true;
	}




	function getReadingPositionLabel(percent: number): string {
		return `阅读位置 ${Math.round(percent)}%`;
	}





	function normalizeFootnoteClickActionForAccess(
		action: EpubReaderSettings['footnoteClickAction'] | undefined
	): EpubReaderSettings['footnoteClickAction'] {
		const normalizedAction = action === 'navigate' || action === 'preview' ? action : 'preview';
		return normalizedAction === 'preview' && !hasFootnotePreviewCapability()
			? 'navigate'
			: normalizedAction;
	}

	function normalizeReaderSettings(readerSettings: EpubReaderSettings): EpubReaderSettings {
		const normalizedSettings = normalizeEpubReaderSettingsForDevice(getReaderDeviceKind(), {
			...readerSettings,
			footnoteClickAction: normalizeFootnoteClickActionForAccess(readerSettings.footnoteClickAction),
		});

		return normalizedSettings;
	}

	function setError(message: string) {
		clearTransientStatus();
		errorMsg = message;
		loading = false;
	}

	function clearTransientStatus() {
		if (transientStatusTimer) {
			clearTimeout(transientStatusTimer);
			transientStatusTimer = null;
		}
		transientStatusText = '';
	}

	function showTransientStatus(message: string, durationMs = 2200) {
		if (transientStatusTimer) {
			clearTimeout(transientStatusTimer);
			transientStatusTimer = null;
		}
		transientStatusText = message;
		if (durationMs > 0) {
			transientStatusTimer = setTimeout(() => {
				transientStatusTimer = null;
				transientStatusText = '';
			}, durationMs);
		}
	}

	function clampReaderSetting(value: number, min: number, max: number, digits = 2): number {
		const clamped = Math.min(Math.max(value, min), max);
		return Number(clamped.toFixed(digits));
	}

	function openTypographyPanel() {
		typographyPopoverOpen = true;
	}

	function closeTypographyPanel() {
		typographyPopoverOpen = false;
	}

	function applyReaderSettingsState(nextSettings: EpubReaderSettings, persist: boolean) {
		const normalizedSettings = normalizeReaderSettings(nextSettings);
		settings = normalizedSettings;
		readerService.setFootnoteClickAction?.(normalizedSettings.footnoteClickAction);
		onReaderSettingsLoaded?.(normalizedSettings);
		if (persist) {
			void storageService.saveReaderSettings(normalizedSettings);
		}
	}

	async function updateReaderSettings(patch: Partial<EpubReaderSettings>) {
		applyAndPersistReaderSettings({
			...settings,
			...patch,
		});
	}

	function previewReaderSettings(nextSettings: EpubReaderSettings) {
		applyReaderSettingsState(nextSettings, false);
	}

	function persistCurrentReaderSettings() {
		applyReaderSettingsState(settings, true);
	}

	function previewReaderLineHeight(value: string) {
		previewReaderSettings({
			...settings,
			lineHeight: clampReaderSetting(Number(value), 1.2, 2.4),
		});
	}

	function previewReaderLetterSpacing(value: string) {
		previewReaderSettings({
			...settings,
			letterSpacing: clampReaderSetting(Number(value), -0.02, 0.24, 3),
		});
	}

	function previewReaderPageMargin(value: string) {
		previewReaderSettings({
			...settings,
			pageMargin: clampReaderSetting(Number(value), 8, 96, 0),
		});
	}

	function setReaderWidthMode(mode: EpubReaderSettings['widthMode']) {
		if (settings.layoutMode === 'double' && mode !== 'fit') {
			return;
		}
		applyAndPersistReaderSettings({
			...settings,
			widthMode: mode,
		});
	}

	function setFootnoteClickAction(action: EpubReaderSettings['footnoteClickAction']) {
		applyAndPersistReaderSettings({
			...settings,
			footnoteClickAction: action,
		});
	}

	function resetReaderTypographySettings() {
		applyAndPersistReaderSettings({
			...settings,
			lineHeight: getDefaultReaderLineHeight(),
			letterSpacing: 0,
			pageMargin: getDefaultReaderPageMargin(),
			widthMode: settings.layoutMode === 'double' ? 'fit' : getDefaultReaderWidthMode(),
			showScrolledSideNav: true,
			footnoteClickAction: 'preview',
		});
	}

	function formatLetterSpacingValue(value: number): string {
		return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
	}

	function handleTypographyPointerDownOutside(event: MouseEvent) {
		if (!typographyPopoverOpen) {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (target?.closest?.('.epub-settings-float')) {
			return;
		}
		closeTypographyPanel();
	}

	function updateReadingReferencePointState(point: EpubReadingReferencePoint | null) {
		readingReferencePoint = point;
		onReadingReferencePointChange?.(point);
	}

	function updateSessionReadingStartPercent(value: number | null | undefined) {
		sessionReadingStartPercent = typeof value === 'number' && Number.isFinite(value)
			? Math.max(0, value)
			: null;
	}

	function clearReaderStoreSyncTimer() {
		if (readerStoreSyncTimer) {
			clearTimeout(readerStoreSyncTimer);
			readerStoreSyncTimer = null;
		}
		pendingReaderStorePatch = {};
	}

	function isActiveEpubReaderInstance(leaf: WorkspaceLeaf | null = app.workspace.activeLeaf): boolean {
		if (!leaf) {
			return false;
		}
		const activePath = getOpenEpubFilePath(leaf);
		const currentPath = normalizePath(String(filePath || '').trim());
		if (currentPath) {
			return !!activePath && pathsReferToSameOpenBook(activePath, currentPath);
		}
		return !activePath;
	}

	function flushReaderStoreSync() {
		clearReaderStoreSyncTimer();
		const patch = pendingReaderStorePatch;
		pendingReaderStorePatch = {};
		if (Object.keys(patch).length > 0 && isActiveEpubReaderInstance()) {
			epubActiveDocumentStore.setSharedState(patch);
		}
	}

	function scheduleReaderStoreSync(patch: Record<string, unknown>) {
		if (!isActiveEpubReaderInstance()) {
			return;
		}
		pendingReaderStorePatch = { ...pendingReaderStorePatch, ...patch };
		if (readerStoreSyncTimer) {
			return;
		}
		readerStoreSyncTimer = setTimeout(() => {
			readerStoreSyncTimer = null;
			const nextPatch = pendingReaderStorePatch;
			pendingReaderStorePatch = {};
			if (Object.keys(nextPatch).length > 0 && isActiveEpubReaderInstance()) {
				epubActiveDocumentStore.setSharedState(nextPatch);
			}
		}, READER_STORE_SYNC_MS);
	}

	function isStaleBookLoad(loadToken: number): boolean {
		return componentDisposed || loadToken !== activeBookLoadToken;
	}

	function rememberHighlightSourcePath(_path?: string | null) {
		// 已断开：不再追踪摘录源文件路径（高亮只由 local-storage.json 驱动）。
	}

	function collectTrackedHighlightSourceFiles(_highlights: ReaderHighlight[]): Set<string> {
		// 已断开：不再收集摘录源文件集合。
		return new Set<string>();
	}

	type HighlightReloadOptions = {
		invalidateCache?: boolean;
		incremental?: boolean;
	};

	function reloadHighlightsAfterExcerptMutation(_sourcePath?: string | null) {
		// 已断开 vault 事件/backlink：任何摘录变更后直接重载 local-storage 高亮。
		void reloadHighlights();
	}


	// 已断开：不再需要 debounce 合并（vault 事件已移除，mutation 直接走 reloadHighlights）。

	function prefetchAnnotationIndexForBook(
		loadedBook: EpubBook,
		targetFilePath: string,
		options?: { priority?: 'immediate' | 'background' }
	) {
		// 已断开：不再预热 backlink 注释索引（高亮数据只来自 local-storage.json）。
		void loadedBook;
		void targetFilePath;
		void options;
	}

	function publishSidebarHighlights(highlights: ReaderHighlight[]) {
		if (!book || !hasExcerptNotesCapability()) {
			return;
		}
		const nextRevision = annotationRevision + 1;
		highlightViewSnapshotService.publishFromHighlights({
			bookId: book.id,
			filePath,
			showStrikethroughHighlights: excerptSettings.showStrikethroughInSidebar,
			revision: nextRevision,
			highlights,
			readerService,
		});
		annotationRevision = nextRevision;
		epubActiveDocumentStore.setSharedState({ annotationRevision });
	}

	function getEpubActionHost() {
		return (app.plugins.getPlugin(CURRENT_PLUGIN_ID) as any) ?? null;
	}

	function getContinuousReadingPositionAutoSaveConfig(): { enabled: boolean; pages: number } {
		const host = getEpubActionHost() as {
			settings?: {
				continuousReadingPositionAutoSaveEnabled?: unknown;
				continuousReadingPositionAutoSavePages?: unknown;
			};
		} | null;

		return {
			enabled: normalizeContinuousReadingPositionAutoSaveEnabled(
				host?.settings?.continuousReadingPositionAutoSaveEnabled
			),
			pages: normalizeContinuousReadingPositionAutoSavePages(
				host?.settings?.continuousReadingPositionAutoSavePages
			),
		};
	}

	async function setContinuousReadingPositionAutoSaveEnabled(enabled: boolean): Promise<boolean> {
		const host = getEpubActionHost() as
			| ({
				settings?: {
					continuousReadingPositionAutoSaveEnabled?: unknown;
					continuousReadingPositionAutoSavePages?: unknown;
				};
				saveSettings?: () => Promise<void>;
			})
			| null;
		const normalizedEnabled = normalizeContinuousReadingPositionAutoSaveEnabled(enabled);
		if (!host?.settings) {
			return normalizedEnabled;
		}
		host.settings.continuousReadingPositionAutoSaveEnabled = normalizedEnabled;
		if (host.settings.continuousReadingPositionAutoSavePages == null) {
			host.settings.continuousReadingPositionAutoSavePages =
				DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES;
		}
		await host.saveSettings?.();
		return normalizedEnabled;
	}

	const bookshelfProgressChangedNotifier = createDebouncedBookshelfProgressChangedNotifier();

	function notifyBookshelfProgressChanged(bookPath?: string) {
		bookshelfProgressChangedNotifier.notify(bookPath);
	}

	async function persistCurrentReadingProgress(
		targetBook: EpubBook | null = book
	): Promise<boolean> {
		if (!hasReadingProgressCapability()) {
			await flushEpubPendingProgress(storageService);
			return false;
		}
		if (!targetBook?.id) {
			await flushEpubPendingProgress(storageService);
			return false;
		}

		const fallbackPosition = targetBook.currentPosition;
		const livePosition = readerReady ? readerService.getCurrentPosition() : fallbackPosition;
		const currentCfi = String(
			livePosition?.cfi || readerService.getCurrentCFI() || fallbackPosition?.cfi || ''
		).trim();

		const position = currentCfi
			? {
				chapterIndex:
					typeof livePosition?.chapterIndex === 'number'
						? livePosition.chapterIndex
						: fallbackPosition?.chapterIndex || 0,
				cfi: currentCfi,
				percent:
					typeof livePosition?.percent === 'number' && Number.isFinite(livePosition.percent)
						? livePosition.percent
						: fallbackPosition?.percent || 0,
			}
			: fallbackPosition;

		if (!position?.cfi) {
			await flushEpubPendingProgress(storageService);
			return false;
		}

		readerService.flushReadingPace?.();
		const readingStats = readerService.getReadingStats?.() ?? targetBook.readingStats;
		if (readingStats) {
			targetBook.readingStats = readingStats;
		}
		targetBook.currentPosition = position;
		await storageService.saveProgress(targetBook.id, position, readingStats);
		await flushEpubPendingProgress(storageService);
		notifyBookshelfProgressChanged(targetBook.filePath);
		return true;
	}

	const EXCERPT_SETTINGS_CHANGED_EVENT = EPUB_RUNTIME.events.excerptSettingsChanged;
	const EPUB_PENDING_NAVIGATION_KEY = EPUB_RUNTIME.globals.pendingNavigationKey;
	const EPUB_NAVIGATE_EVENT = EPUB_RUNTIME.events.navigate;
	const LEGACY_EPUB_PENDING_NAVIGATION_KEY = EPUB_PENDING_NAVIGATION_KEY === '__weaveEpubStandalonePendingNav'
		? '__weaveEpubPendingNav'
		: null;
	const LEGACY_EPUB_NAVIGATE_EVENT = EPUB_NAVIGATE_EVENT === 'WeaveEpubStandalone:epub-navigate'
		? 'Weave:epub-navigate'
		: null;

	function syncReadingProgressDisplay(rawPercent?: number): void {
		const currentBook = book;
		if (!currentBook) {
			readingProgress = 0;
			return;
		}
		readingProgress = resolveDisplayProgress(currentBook, rawPercent);
	}

	async function markCurrentBookCompleted(): Promise<void> {
		const currentBook = book;
		if (!currentBook?.id || !hasReadingProgressCapability()) {
			return;
		}
		const updated = await storageService.markBookCompleted(currentBook.id);
		if (!updated) {
			return;
		}
		currentBook.readingStats = updated.readingStats;
		syncReadingProgressDisplay();
		epubActiveDocumentStore.setSharedState({
			progress: readingProgress,
		});
		notifyBookshelfProgressChanged(currentBook.filePath);
		const title = currentBook.metadata.title?.trim() || currentBook.filePath;
		new Notice(`已标记《${title}》为已读完`);
	}

	async function handleBookEndAdvanceAttempt(): Promise<boolean> {
		if (!hasReadingProgressCapability()) {
			return false;
		}
		const currentBook = book;
		if (!currentBook?.id || !readerService.isAtBookEnd?.()) {
			return false;
		}
		if (isBookCompleted(currentBook.readingStats)) {
			return true;
		}
		if (bookCompletionPromptOpen) {
			return true;
		}
		if (bookCompletionPromptDismissedBookId === currentBook.id) {
			return true;
		}

		bookCompletionPromptOpen = true;
		const title = currentBook.metadata.title?.trim() || currentBook.filePath;
		const confirmed = await showObsidianConfirm(
			app,
			`你已到达《${title}》的末尾。是否将本书标记为已读完？\n\n标记后阅读进度将保持 100%，续读位置仍会照常记录。`,
			{
				title: '标记为已读完',
				confirmText: '标记已读完',
			}
		);
		bookCompletionPromptOpen = false;
		if (confirmed) {
			await markCurrentBookCompleted();
		} else {
			bookCompletionPromptDismissedBookId = currentBook.id;
		}
		return true;
	}

	async function openScanImportModal(scanEntries?: Awaited<ReturnType<typeof storageService.loadScanIndex>>) {
		const entries = scanEntries ?? await storageService.loadScanIndex();
		if (entries.length === 0) {
			new Notice('我的书架：当前仓库中未发现书籍或漫画');
			return;
		}

		const membership = await storageService.loadBookshelfMembership();
		const { EpubBookshelfImportModal } = await import('../modals/EpubBookshelfImportModal');
		const modal = new EpubBookshelfImportModal(app, {
			entries,
			membership,
			title: '扫描库中书籍和漫画',
			onConfirm: async (paths: string[]) => {
				const addedEntries = await storageService.addBooksToBookshelf(paths);
				if (addedEntries.length === 0) {
					new Notice(
						paths.length > 0
							? '我的书架：所选书籍无法加入（路径无法解析或存在重名冲突），请刷新扫描后重试'
							: '我的书架：所选书籍或漫画已在书架中'
					);
					return;
				}
				dispatchEpubBookshelfDataChanged();
				new Notice(`我的书架：已加入 ${addedEntries.length} 本书籍或漫画`);
			},
		});
		modal.open();
	}

	async function scanVaultAndPromptImport() {
		try {
			const scanEntries = await storageService.scanVaultBooks();
			dispatchEpubBookshelfDataChanged();

			if (scanEntries.length === 0) {
				new Notice('我的书架：当前仓库中未发现书籍或漫画');
				return;
			}

			await openScanImportModal(scanEntries);
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to scan vault EPUB files:', error);
			new Notice('我的书架：扫描书籍和漫画失败');
		}
	}

	async function requestBookshelfRefresh() {
		dispatchEpubBookshelfRefreshRequest(undefined, { showNotice: true });
	}


	function syncBookSessionForPath(nextFilePath: string): BookSession {
		const manager = getBookSessionManager(app);
		if (!manager.pathsShareSession(filePath, nextFilePath)) {
			manager.release(filePath);
		}
		bookSession = manager.acquire(nextFilePath);
		return bookSession;
	}

	function syncReaderHighlightsFromCollection(
		nextHighlights: ReaderHighlight[],
		previousHighlights: ReaderHighlight[]
	): void {
		if (!readerReady) {
			return;
		}
		const previousByKey = new Map(
			previousHighlights.map((highlight) => [
				getReaderHighlightIdentityKey(highlight),
				highlight,
			])
		);
		for (const highlight of nextHighlights) {
			const key = getReaderHighlightIdentityKey(highlight);
			if (!key) {
				continue;
			}
			const previous = previousByKey.get(key);
			if (!previous || hasReaderHighlightPresentationChanged(previous, highlight)) {
				readerService.addHighlight(highlight);
			}
		}
	}

	function buildHighlightIdentityFields(info: HighlightClickInfo) {
		// 已断开：仅兼容旧调用点。
		return {
			cfiRange: info.cfiRange,
			text: info.text,
			excerptId: info.excerptId,
			sourceFile: info.sourceFile,
			sourceRef: info.sourceRef,
			createdTime: info.createdTime,
		};
	}

	function purgeOrphanHighlightFromReader(info: HighlightClickInfo): void {
		// 已断开：来源持久化校验不再需要，删除路径直接处理 local-storage 高亮。
		void info;
	}

	async function isHighlightStillPersistedInSource(
		info: HighlightClickInfo
	): Promise<boolean> {
		// 已断开：不校验 backlink 源持久化，local-storage 高亮视为已持久化。
		void info;
		return true;
	}

	async function finalizeHighlightRemoval(
		info: HighlightClickInfo,
		options?: { quiet?: boolean }
	): Promise<void> {
		// 已断开：直接按 local-storage 高亮删除。
		purgeOrphanHighlightFromReader(info);
		if (!options?.quiet) {
			new Notice('高亮已删除');
		}
		reloadHighlightsAfterExcerptMutation();
	}

	async function syncHighlightsAfterSourcePathChange(sourcePath?: string | null): Promise<boolean> {
		// 已断开：不再按 vault 源文件增量同步，local-storage 高亮由 reloadHighlights 统一重载。
		void sourcePath;
		return false;
	}

	function resolveCommentDraftFromMemory(info: HighlightClickInfo): string {
		const key = getReaderHighlightIdentityKey({
			cfiRange: info.cfiRange,
			text: info.text,
			excerptId: info.excerptId,
			sourceFile: info.sourceFile,
			sourceRef: info.sourceRef,
			createdTime: info.createdTime,
		});
		if (key) {
			const loaded = pendingLoadedHighlights.find(
				(highlight) => getReaderHighlightIdentityKey(highlight) === key
			);
			if (loaded?.commentText) {
				return loaded.commentText;
			}
		}
		return info.commentText || '';
	}

	async function resolveCommentDraftFromSource(info: HighlightClickInfo): Promise<string> {
		// 已断开：不再从 backlink 源读取评论草稿，只读内存/local-storage 数据。
		return resolveCommentDraftFromMemory(info);
	}

	function applyIncomingReaderHighlights(_incoming: ReaderHighlight[]): boolean {
		// 已断开：卡片乐观同步不再使用。
		return false;
	}

	async function mergeHighlightsFromSourcePath(_sourcePath?: string | null): Promise<boolean> {
		// 已断开：不再从 vault 源路径合并高亮。
		return false;
	}



	function applyAndPersistReaderSettings(nextSettings: EpubReaderSettings) {
		applyReaderSettingsState(nextSettings, true);
	}

	async function finalizeBookLoad(
		loadToken: number,
		loadedBook: EpubBook,
		targetFilePath: string,
		reusableBook: EpubBook | null
	): Promise<void> {
		if (isStaleBookLoad(loadToken)) {
			return;
		}

		try {
			const sourceEntry = await storageService.ensureSourceIdentity(targetFilePath, {
				preferredSourceId: reusableBook?.sourceId,
			});
			if (isStaleBookLoad(loadToken)) {
				return;
			}

			if (sourceEntry) {
				loadedBook.sourceId = sourceEntry.sourceId;
				loadedBook.sourceFingerprint = sourceEntry.sourceFingerprint;
				loadedBook.sourceSize = sourceEntry.sourceSize;
				loadedBook.sourceMtime = sourceEntry.sourceMtime;
				loadedBook.filePath = sourceEntry.filePath;
			} else if (reusableBook?.sourceId) {
				loadedBook.sourceId = reusableBook.sourceId;
			}

			await storageService.saveBook(loadedBook);
			if (isStaleBookLoad(loadToken)) {
				return;
			}

			await refreshReadingReferencePointState(loadedBook.id);
			if (isStaleBookLoad(loadToken)) {
				return;
			}

			void reloadHighlights();
			prefetchAnnotationIndexForBook(loadedBook, targetFilePath, { priority: 'immediate' });
		} catch (error) {
			logger.warn('[EpubReaderApp] Deferred book persistence failed:', error);
		}
	}

	async function cancelSlowBookLoad() {
		activeBookLoadToken += 1;
		bookLoadSlowWarning = false;
		loading = false;
		errorMsg = '';
		try {
			await onCancelBookLoad?.();
		} catch (error) {
			logger.warn('[EpubReaderApp] Failed to cancel book load:', error);
		}
	}

	async function loadBook() {
		syncBookSessionForPath(filePath);
		const loadToken = ++activeBookLoadToken;
		const targetFilePath = filePath;
		const previousBook = book;
		if (previousBook?.id) {
			void persistCurrentReadingProgress(previousBook);
		}
		loading = true;
		bookLoadSlowWarning = false;
		errorMsg = '';
		readerReady = false;
		highlightReloading = false;
		pendingLoadedHighlights = null;
		highlightToolbarInfo = null;
		commentEditorInfo = null;
		footnotePreviewInfo = null;
		commentEditorDraft = '';
		commentEditorSaving = false;
		updateReadingReferencePointState(null);
		updateSessionReadingStartPercent(null);
		try {
			const canonicalFilePath =
				storageService.resolveSupportedBookFilePath(targetFilePath) || targetFilePath;
			if (canonicalFilePath !== targetFilePath) {
				await storageService.updateBookFileReferences(targetFilePath, canonicalFilePath);
			}
			const vaultFile = app.vault.getAbstractFileByPath(canonicalFilePath);
			if (!isSupportedBookFile(vaultFile)) {
				if (await storageService.isBookshelfSourceMissing(targetFilePath)) {
					await storageService.removeMissingBookshelfEntry(targetFilePath);
					throw new Error('这本书的源文件已不存在，已从书架移除');
				}
				throw new Error('未找到对应的书籍文件');
			}

			const existingBook =
				(await storageService.findBookByFilePath(canonicalFilePath))
				|| (canonicalFilePath !== targetFilePath
					? await storageService.findBookByFilePath(targetFilePath)
					: null);
			if (isStaleBookLoad(loadToken)) {
				return;
			}
			if (existingBook?.id) {
				await storageService.hydrateBookState(existingBook.id);
			}
			if (isStaleBookLoad(loadToken)) {
				return;
			}
			const reusableBook = canReuseExistingBook(existingBook, vaultFile) ? existingBook : null;
			if (existingBook && !reusableBook) {
				await storageService.removeBookByFilePath(canonicalFilePath);
				showTransientStatus(
					`检测到 ${getBookFormatDisplayLabel(canonicalFilePath)} 文件已更新，已按新导入重建阅读缓存`,
					3200
				);
			}
			const loadedBook = await runBookLoadSession({
				filePath: canonicalFilePath,
				fileSizeBytes: vaultFile.stat.size,
				loadPromise: readerService.loadEpub(canonicalFilePath, reusableBook?.id),
				onSlowLoad: () => {
					if (!isStaleBookLoad(loadToken)) {
						bookLoadSlowWarning = true;
					}
				},
				isCancelled: () => isStaleBookLoad(loadToken),
			});

			if (isStaleBookLoad(loadToken)) {
				return;
			}

			if (reusableBook) {
				loadedBook.readingStats = reusableBook.readingStats;
				const storedTitle = reusableBook.metadata?.title?.trim();
				if (storedTitle) {
					loadedBook.metadata = {
						...loadedBook.metadata,
						title: storedTitle,
					};
				}
			}

			const sourceEntry = await storageService.ensureSourceIdentity(canonicalFilePath, {
				preferredSourceId: reusableBook?.sourceId,
				preferredSourceFingerprint: reusableBook?.sourceFingerprint,
			});
			if (isStaleBookLoad(loadToken)) {
				return;
			}
			if (sourceEntry) {
				loadedBook.sourceId = sourceEntry.sourceId;
				loadedBook.sourceFingerprint = sourceEntry.sourceFingerprint;
				loadedBook.sourceSize = sourceEntry.sourceSize;
				loadedBook.sourceMtime = sourceEntry.sourceMtime;
				loadedBook.filePath = sourceEntry.filePath;
			} else if (reusableBook?.sourceId) {
				loadedBook.sourceId = reusableBook.sourceId;
				loadedBook.sourceFingerprint = reusableBook.sourceFingerprint;
			}

			const restoredPosition = await resolveBookLoadRestoredPosition({
				hasProgressCapability: hasReadingProgressCapability(),
				reusableBook,
				loadedBook,
				loadProgress: (bookId, book) => storageService.loadProgress(bookId, book),
			});
			if (isStaleBookLoad(loadToken)) {
				return;
			}
			if (hasReadingProgressCapability() && restoredPosition?.cfi) {
				loadedBook.currentPosition = restoredPosition;
				await readerService.setRestoredPosition?.(restoredPosition);
			}

			book = loadedBook;
			bookCompletionPromptDismissedBookId = '';
			currentChapterIndex = loadedBook.currentPosition?.chapterIndex ?? 0;
			syncReadingProgressDisplay(loadedBook.currentPosition?.percent ?? 0);
			updateSessionReadingStartPercent(readingProgress);
			showScrolledChapterNavActions = false;
			bookmarkRevision = 0;
			onTitleChange?.(loadedBook.metadata.title);
			if (isActiveEpubReaderInstance()) {
				epubActiveDocumentStore.setSharedState({ filePath: targetFilePath, book: loadedBook });
			}
			syncAsActiveEpubDocumentIfActive();
			prefetchAnnotationIndexForBook(loadedBook, targetFilePath, { priority: 'immediate' });

			// Unblock the reader shell as soon as the engine can render.
			loading = false;
			void finalizeBookLoad(loadToken, loadedBook, targetFilePath, reusableBook);
		} catch (error) {
			if (isStaleBookLoad(loadToken) || error instanceof BookLoadCancelledError) {
				return;
			}
			logger.error(
				`[EpubReaderApp] Failed to load ${getBookFormatDisplayLabel(targetFilePath)}:`,
				error
			);
			setError(`${error instanceof Error ? error.message : '未知错误'}`);
		} finally {
			if (!isStaleBookLoad(loadToken)) {
				loading = false;
			}
		}
	}

	async function refreshReadingReferencePointState(bookId?: string | null) {
		if (!hasReadingReferenceCapability()) {
			updateReadingReferencePointState(null);
			return;
		}
		const normalizedBookId = String(bookId || '').trim();
		if (!normalizedBookId) {
			updateReadingReferencePointState(null);
			return;
		}

		try {
			const point = await storageService.loadReadingReferencePoint(normalizedBookId);
			updateReadingReferencePointState(point);
		} catch (error) {
			logger.warn('[EpubReaderApp] Failed to load reading reference point:', error);
			updateReadingReferencePointState(null);
		}
	}


	async function addBookmark() {
		if (!book) {
			new Notice('未加载书籍');
			return;
		}
		try {
			const pos = readerService.getCurrentPosition();
			let currentCfi = EpubLinkService.normalizeCfi(
				pos.cfi || readerService.getCurrentCFI() || book.currentPosition?.cfi || ''
			);
			if (!currentCfi) {
				new Notice('无法获取当前阅读位置');
				return;
			}

			if (typeof readerService.canonicalizeLocation === 'function') {
				const canonicalCfi = await readerService.canonicalizeLocation(currentCfi);
				if (canonicalCfi) {
					currentCfi = canonicalCfi;
				}
			}

			const chapterTitle = readerService.getCurrentChapterTitle() || getReadingPositionLabel(pos.percent);
			const result = await bookmarkService.addBookmark(book, {
				cfi: currentCfi,
				chapterIndex: pos.chapterIndex,
				percent: pos.percent,
				chapterTitle,
				pageNumber: settings.flowMode !== 'scrolled' && paginationInfo.currentPage > 0
					? paginationInfo.currentPage
					: undefined,
				totalPages: settings.flowMode !== 'scrolled' && paginationInfo.totalPages > 0
					? paginationInfo.totalPages
					: undefined,
				createdAt: Date.now(),
				preview: chapterTitle,
			});
			bookmarkRevision += 1;
			epubActiveDocumentStore.setSharedState({ bookmarkRevision });
			new Notice(result.created ? '书签已添加' : '当前页已有书签');
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to add bookmark:', error);
			new Notice('书签操作失败');
		}
	}

	async function deleteBookmarkById(bookmarkId: string): Promise<boolean> {
		if (!book) {
			new Notice('未加载书籍');
			return false;
		}

		try {
			const deleted = await bookmarkService.deleteBookmark(book, bookmarkId);
			if (!deleted) {
				new Notice('书签不存在或已删除');
				return false;
			}
			bookmarkRevision += 1;
			epubActiveDocumentStore.setSharedState({ bookmarkRevision });
			new Notice('书签已删除');
			return true;
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to delete bookmark:', error);
			new Notice('删除书签失败');
			return false;
		}
	}

	async function buildReadingReferencePoint(position?: ReadingPosition | null): Promise<EpubReadingReferencePoint | null> {
		if (!book) {
			return null;
		}

		const currentPosition = position ?? readerService.getCurrentPosition();
		let currentCfi = EpubLinkService.normalizeCfi(
			currentPosition.cfi || readerService.getCurrentCFI() || book.currentPosition?.cfi || ''
		);
		if (!currentCfi) {
			return null;
		}

		if (typeof readerService.canonicalizeLocation === 'function') {
			const canonicalCfi = await readerService.canonicalizeLocation(currentCfi);
			if (canonicalCfi) {
				currentCfi = canonicalCfi;
			}
		}

		const percent =
			typeof currentPosition.percent === 'number' && Number.isFinite(currentPosition.percent)
				? currentPosition.percent
				: book.currentPosition?.percent || 0;
		const chapterIndex =
			typeof currentPosition.chapterIndex === 'number' && Number.isFinite(currentPosition.chapterIndex)
				? currentPosition.chapterIndex
				: book.currentPosition?.chapterIndex || 0;
		const chapterTitle = readerService.getCurrentChapterTitle()
			|| getReadingPositionLabel(percent);

		return {
			chapterIndex,
			cfi: currentCfi,
			percent,
			title: chapterTitle,
			savedAt: Date.now(),
		};
	}

	async function saveReadingReferencePoint() {
		if (!book) {
			new Notice('未加载书籍');
			return;
		}

		try {
			const point = await buildReadingReferencePoint();
			if (!point) {
				new Notice('无法获取当前阅读位置');
				return;
			}

			await storageService.saveReadingReferencePoint(book.id, point);
			updateReadingReferencePointState(point);
			showTransientStatus(`已记录参考位置：${point.title}`, 2600);
			new Notice('参考阅读位置已记录');
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to save reading reference point:', error);
			new Notice('记录参考阅读位置失败');
		}
	}

	async function syncReadingReferencePointFromAutoSave(position: ReadingPosition): Promise<void> {
		if (!hasReadingReferenceCapability()) {
			return;
		}
		if (!book) {
			return;
		}

		try {
			const point = await buildReadingReferencePoint(position);
			if (!point) {
				return;
			}

			await storageService.saveReadingReferencePoint(book.id, point);
			updateReadingReferencePointState(point);
		} catch (error) {
			logger.warn('[EpubReaderApp] Failed to sync reading reference point from auto-saved reading progress:', error);
		}
	}

	async function handleAutoReadingPositionSaved(position: ReadingPosition): Promise<void> {
		await syncReadingReferencePointFromAutoSave(position);
		await flushEpubPendingProgress(storageService);
		notifyBookshelfProgressChanged(book?.filePath);
	}

	async function goToReadingReferencePoint() {
		if (!readingReferencePoint?.cfi) {
			new Notice('尚未记录参考阅读位置');
			return;
		}
		try {
			const referenceTitle = readingReferencePoint.title || '参考阅读位置';
			requestBookLocate({
				cfi: readingReferencePoint.cfi,
				flashStyle: 'highlight',
				showLocateOverlay: true,
			});
			showTransientStatus(`已跳转到参考位置：${referenceTitle}`, 2200);
			new Notice('已跳转到参考阅读位置');
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to jump to reading reference point:', error);
			new Notice('跳转到参考阅读位置失败');
		}
	}

	async function clearReadingReferencePoint() {
		if (!book) {
			new Notice('未加载书籍');
			return;
		}
		try {
			await storageService.deleteReadingReferencePoint(book.id);
			updateReadingReferencePointState(null);
			showTransientStatus('已清除参考阅读位置', 2200);
			new Notice('已清除参考阅读位置');
		} catch (error) {
			logger.error('[EpubReaderApp] Failed to clear reading reference point:', error);
			new Notice('清除参考阅读位置失败');
		}
	}

	function openReadingReferencePointMenu(event: MouseEvent | KeyboardEvent) {
		const canUseReference = hasReadingReferenceCapability();
		const canUseProgress = hasReadingProgressCapability();
		const autoSaveEnabled = getContinuousReadingPositionAutoSaveConfig().enabled;
		const menu = new Menu();

		if (canUseReference && readingReferencePoint) {
			menu.addItem((item) => {
				item.setTitle(getReadingReferenceTitleText());
				item.setIcon('flag');
				item.setDisabled(true);
			});
			menu.addSeparator();
			menu.addItem((item) => {
				item.setTitle('跳转到已记录位置');
				item.setIcon('locate-fixed');
				item.onClick(() => {
					void goToReadingReferencePoint();
				});
			});
			menu.addItem((item) => {
				item.setTitle('更新为当前位置');
				item.setIcon('flag');
				item.onClick(() => {
					void saveReadingReferencePoint();
				});
			});
			menu.addItem((item) => {
				item.setTitle('清除已记录位置');
				item.setIcon('trash-2');
				item.onClick(() => {
					void clearReadingReferencePoint();
				});
			});
		} else if (canUseReference) {
			menu.addItem((item) => {
				item.setTitle('记录当前阅读位置');
				item.setIcon('flag');
				item.onClick(() => {
					void saveReadingReferencePoint();
				});
			});
		}

		if (canUseReference) {
			menu.addSeparator();
		}

		if (canUseProgress) {
			menu.addItem((item) => {
				item.setTitle('连续阅读后自动更新');
				item.setIcon(autoSaveEnabled ? 'locate-fixed' : 'map-pinned');
				item.setChecked(autoSaveEnabled);
				item.onClick(() => {
					void (async () => {
						const nextEnabled = !getContinuousReadingPositionAutoSaveConfig().enabled;
						await setContinuousReadingPositionAutoSaveEnabled(nextEnabled);
						onReadingPositionAutoSaveChange?.();
						new Notice(
							nextEnabled
								? '已开启自动记录阅读位置'
								: '已关闭自动记录阅读位置'
						);
					})();
				});
			});
		}

		showMenuAtAnchor(menu, event);
	}

	async function applyAndPersistExcerptSettings(patch: Partial<EpubExcerptSettings>) {
		const nextExcerptSettings = {
			...excerptSettings,
			...patch,
		};
		excerptSettings = nextExcerptSettings;
		epubActiveDocumentStore.setSharedState({ excerptSettings: nextExcerptSettings });
		await storageService.saveExcerptSettings(nextExcerptSettings);
	}

	async function syncExcerptSettingsFromStorage() {
		try {
			const savedExcerptSettings = await storageService.loadExcerptSettings();
			excerptSettings = savedExcerptSettings;
			excerptSettingsLoaded = true;
			epubActiveDocumentStore.setSharedState({ excerptSettings: savedExcerptSettings });
		} catch (error) {
			logger.warn('[EpubReaderApp] Failed to sync excerpt settings:', error);
		}
	}

	function resolveExcerptChapterTitle(): string {
		const format = excerptSettings.chapterLocationFormat ?? 'leaf';
		if (typeof readerService.getChapterLocationLabel === 'function') {
			return readerService.getChapterLocationLabel(format);
		}
		return readerService.getCurrentChapterTitle();
	}

	function resolveExcerptChapterLabelMaxLength(): number {
		return excerptSettings.chapterLocationFormat === 'full'
			? EpubLinkService.MAX_FULL_CHAPTER_LABEL_LENGTH
			: EpubLinkService.MAX_CHAPTER_LABEL_LENGTH;
	}

	function handleGlobalExcerptSettingsChanged(event: Event) {
		const detail = event instanceof CustomEvent ? event.detail : null;
		const nextExcerptSettings = detail?.settings;
		if (!nextExcerptSettings || typeof nextExcerptSettings !== 'object') {
			void syncExcerptSettingsFromStorage();
			return;
		}
		excerptSettings = nextExcerptSettings as EpubExcerptSettings;
		excerptSettingsLoaded = true;
		epubActiveDocumentStore.setSharedState({ excerptSettings });
	}

	function showSettingsMenu(evt: MouseEvent) {
		const menu = new Menu();
		const bookshelfSettingsHost = (app.plugins.getPlugin(CURRENT_PLUGIN_ID) as any) ?? null;
		const currentBookshelfDisplayMode = normalizeBookshelfDisplayMode(
			bookshelfSettingsHost?.settings?.bookshelfDisplayMode ?? DEFAULT_BOOKSHELF_DISPLAY_MODE
		);

		const applyBookshelfDisplayMode = (mode: BookshelfDisplayMode) => {
			void (async () => {
				if (!bookshelfSettingsHost?.settings) {
					return;
				}
				bookshelfSettingsHost.settings.bookshelfDisplayMode = mode;
				bookshelfSettingsHost.settings.bookshelfAutoViewByLocationEnabled = mode === 'adaptive';
				if (typeof bookshelfSettingsHost.saveSettings === 'function') {
					await bookshelfSettingsHost.saveSettings();
				}
				window.dispatchEvent(new CustomEvent(EPUB_RUNTIME.events.bookshelfDisplaySettingsChanged, {
					detail: {
						enabled: mode === 'adaptive',
						mode,
					},
				}));
				new Notice(`我的书架已切换为${getBookshelfDisplayModeOption(mode).label}`);
			})();
		};

		menu.addItem((item) => {
			item.setTitle('书架显示功能');
			item.setIcon('library');
			const subMenu = (item as any).setSubmenu();

			for (const option of getBookshelfDisplayModeOptions()) {
				subMenu.addItem((subItem: any) => {
					subItem.setTitle(option.label);
					subItem.setIcon(option.icon);
					subItem.setChecked(currentBookshelfDisplayMode === option.mode);
					subItem.onClick(() => {
						applyBookshelfDisplayMode(option.mode);
					});
				});
			}
		});

		menu.addItem((item) => {
			item.setTitle('扫描库中书籍和漫画');
			item.setIcon('scan-search');
			item.onClick(() => {
				void scanVaultAndPromptImport();
			});
		});

		menu.addItem((item) => {
			item.setTitle('刷新书架');
			item.setIcon('refresh-cw');
			item.onClick(() => {
				void requestBookshelfRefresh();
			});
		});

		menu.showAtMouseEvent(evt);
	}

	function handleLayoutModeChange(mode: EpubLayoutMode) {
		if (isMobileReader()) {
			mode = 'paginated';
		}
		applyAndPersistReaderSettings({
			...settings,
			layoutMode: mode,
			widthMode: mode === 'double' ? 'fit' : settings.widthMode
		});
	}

	function handleFlowModeChange(mode: EpubFlowMode) {
		applyAndPersistReaderSettings({
			...settings,
			layoutMode: mode === 'scrolled' ? 'paginated' : settings.layoutMode,
			flowMode: mode
		});
	}

	function handleScrolledSideNavToggle(enabled: boolean) {
		applyAndPersistReaderSettings({
			...settings,
			showScrolledSideNav: enabled
		});
	}

	function showBottomNav() {
		return settings.flowMode !== 'scrolled' || (!isMobileReader() && settings.showScrolledSideNav);
	}

	function useVerticalNav() {
		return settings.flowMode === 'scrolled';
	}

	function getBottomNavStatusText(): string | undefined {
		if (transientStatusText.trim()) {
			if (!useVerticalNav()) {
				return undefined;
			}
			return transientStatusText;
		}
		if (!useVerticalNav()) {
			return undefined;
		}
		if (!hasReadingProgressCapability()) {
			return undefined;
		}
		return `${Math.max(0, Math.round(readingProgress))}%`;
	}

	function getBottomNavStatusDetail(): string | undefined {
		if (useVerticalNav()) {
			return undefined;
		}
		const detail = transientStatusText.trim();
		return detail || undefined;
	}

	function getReadingReferenceDeltaText(): string {
		if (sessionReadingStartPercent === null) {
			return '0%';
		}
		const delta = Math.round(readingProgress - sessionReadingStartPercent);
		return delta > 0 ? `+${delta}%` : `${delta}%`;
	}

	function getReadingReferenceTitleText(): string {
		if (!readingReferencePoint) {
			return '本次阅读累计新增';
		}
		const currentDelta = getReadingReferenceDeltaText();
		const resumePercent = Math.max(0, Math.round(readingReferencePoint.percent));
		const title = String(
			readingReferencePoint.title || getReadingPositionLabel(resumePercent)
		).trim();
		return `本次阅读累计新增：${currentDelta}；自动续读点：${resumePercent}%（${title}）`;
	}

	function showMenuAtAnchor(menu: Menu, event: MouseEvent | KeyboardEvent) {
		if (domInstanceOf(event, MouseEvent)) {
			menu.showAtMouseEvent(event);
			return;
		}
		menu.showAtPosition({
			x: Math.max(24, Math.round(window.innerWidth / 2)),
			y: Math.max(24, Math.round(window.innerHeight / 2)),
		});
	}

	function clearScrolledNavMetrics() {
		rootEl?.style.removeProperty(SCROLLED_NAV_FRAME_INSET_VAR);
		rootEl?.style.removeProperty(SCROLLED_NAV_SCROLLBAR_VAR);
	}

	function getVisibleReaderFrameGeometry(): {
		frameElement: HTMLElement;
		frameWindow: Window;
		frameDocument: Document;
	} | null {
		for (const frame of readerService.getVisibleFrames()) {
			const frameElement = frame.window?.frameElement;
			if (!domInstanceOf(frameElement, HTMLElement)) {
				continue;
			}
			return {
				frameElement,
				frameWindow: frame.window,
				frameDocument: frame.frameDocument,
			};
		}
		return null;
	}

	function syncScrolledNavMetrics() {
		if (!rootEl || !viewportEl || !showBottomNav() || !useVerticalNav()) {
			clearScrolledNavMetrics();
			return;
		}

		const frameGeometry = getVisibleReaderFrameGeometry();
		if (!frameGeometry) {
			clearScrolledNavMetrics();
			return;
		}

		const viewportRect = viewportEl.getBoundingClientRect();
		const frameRect = frameGeometry.frameElement.getBoundingClientRect();
		const documentElement = frameGeometry.frameDocument.documentElement;
		const body = frameGeometry.frameDocument.body;
		const contentWidth = Math.max(documentElement?.clientWidth || 0, body?.clientWidth || 0);
		const scrollbarWidth = Math.max(0, frameGeometry.frameWindow.innerWidth - contentWidth);
		const frameInsetEnd = Math.max(0, viewportRect.right - frameRect.right);

		rootEl.style.setProperty(SCROLLED_NAV_FRAME_INSET_VAR, `${frameInsetEnd}px`);
		rootEl.style.setProperty(SCROLLED_NAV_SCROLLBAR_VAR, `${scrollbarWidth}px`);
	}

	function scheduleScrolledNavLayoutSync() {
		if (scrolledNavSyncFrame) {
			return;
		}
		scrolledNavSyncFrame = window.requestAnimationFrame(() => {
			scrolledNavSyncFrame = 0;
			syncScrolledNavMetrics();
		});
	}

	function setupScrolledNavMetricsObserver() {
		if (scrolledNavResizeObserver) {
			scrolledNavResizeObserver.disconnect();
		}
		scrolledNavResizeObserver = new ResizeObserver(() => {
			scheduleScrolledNavLayoutSync();
		});
		if (rootEl) {
			scrolledNavResizeObserver.observe(rootEl);
		}
		if (viewportEl) {
			scrolledNavResizeObserver.observe(viewportEl);
		}
	}

	async function handlePrevPage() {
		await readerService.prevPage();
	}

	async function handleNextPage() {
		await readerService.nextPage();
	}

	function flipPage(zone: 'prev' | 'next'): void {
		if (zone === 'prev') {
			void handlePrevPage();
		} else {
			void handleNextPage();
		}
	}

	function cancelPendingTapTurn(): void {
		if (tapTurnTimer) {
			window.clearTimeout(tapTurnTimer);
			tapTurnTimer = null;
		}
		tapTurnZone = null;
	}

	function scheduleTapTurn(zone: 'prev' | 'next', delayMs: number): void {
		cancelPendingTapTurn();
		tapTurnZone = zone;
		tapTurnTimer = window.setTimeout(() => {
			tapTurnTimer = null;
			const turnZone = tapTurnZone;
			tapTurnZone = null;
			tapBurstTracker.reset();
			flipPage(turnZone);
		}, delayMs);
	}

	function toggleMobileFullscreen(): void {
		const next = !mobileFullscreen;
		mobileFullscreen = next;
		document.body.classList.toggle('weave-epub-fullscreen', next);
	}

	function handleReaderTap(event: ReaderTapEvent): void {
		if (!readerReady) {
			return;
		}
		const count = tapBurstTracker.push({ time: performance.now() });
		if (count >= 3) {
			// 三连击：取消待翻页，切换全屏
			cancelPendingTapTurn();
			tapBurstTracker.reset();
			toggleMobileFullscreen();
			return;
		}
		// 首次点按等 100ms 宽限（给三连击留余地）；连击点按等满 300ms 窗口
		scheduleTapTurn(event.zone, count === 1 ? TAP_FLIP_GRACE_MS : TAP_TRIPLE_WINDOW_MS);
	}


	async function handleJumpToPage(pageNumber: number) {
		await readerService.goToPage(pageNumber);
	}

	function hasPrevChapter(): boolean {
		return Boolean(book && currentChapterIndex > 0);
	}

	function hasNextChapter(): boolean {
		return Boolean(book && currentChapterIndex >= 0 && currentChapterIndex < book.metadata.chapterCount - 1);
	}

	function syncScrolledChapterNavVisibility() {
		const atChapterEnd = Boolean(readerService.isAtCurrentChapterEnd?.());
		showScrolledChapterNavActions = Boolean(
			atChapterEnd && (hasPrevChapter() || hasNextChapter())
		);
	}

	async function handlePrevChapter() {
		if (!hasPrevChapter()) {
			return;
		}

		const moved = await readerService.prevChapter?.();
		if (!moved) {
			new Notice('已经是第一章节');
			return;
		}

		showScrolledChapterNavActions = false;
	}

	async function handleNextChapter() {
		if (!hasNextChapter()) {
			return;
		}

		const moved = await readerService.nextChapter?.();
		if (!moved) {
			new Notice('已经是最后一章节');
			return;
		}

		showScrolledChapterNavActions = false;
	}

	function resolveExcerptLinkSourcePath(forEditorInsert: boolean): string | undefined {
		if (!forEditorInsert) {
			return undefined;
		}
		return (getLastActiveMarkdownLeaf?.()?.view as MarkdownView | undefined)?.file?.path;
	}

	function buildNoteContent(
		text: string,
		cfiRange: string,
		color?: string,
		style?: EpubHighlightStyle,
		forEditorInsert = false
	): string {
		const chapterIndex = readerService.getCurrentChapterIndex();
		const chapterTitle = resolveExcerptChapterTitle();
		const timestamp = excerptSettings.addCreationTime ? formatTimestamp(new Date()) : undefined;
		return linkService.buildQuoteBlock(
			filePath,
			cfiRange,
			text,
			chapterIndex,
			color,
			chapterTitle,
			timestamp,
			resolveExcerptLinkSourcePath(forEditorInsert),
			book?.sourceId,
			undefined,
			style,
			resolveExcerptChapterLabelMaxLength()
		);
	}

	function formatTimestamp(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	}

	function insertToEditor(content: string): string | null {
		const leaf = getLastActiveMarkdownLeaf?.();
		if (!leaf) {
			new Notice('未找到活动的 Markdown 编辑器');
			return null;
		}
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.editor) {
			new Notice('未找到活动的 Markdown 编辑器');
			return null;
		}
		const editor = view.editor;
		const cursor = editor.getCursor();
		editor.replaceRange(content + '\n', cursor);
		const lines = content.split('\n').length;
		editor.setCursor({ line: cursor.line + lines, ch: 0 });
		return view.file?.path || null;
	}

	function insertToEditorAndTrack(content: string) {
		insertToEditor(content);
	}

	async function copyTextToClipboard(content: string) {
		try {
			await navigator.clipboard.writeText(content);
			new Notice('已复制到剪贴板');
		} catch (_e) {
			new Notice('复制失败');
		}
	}

	function outputNote(text: string, cfiRange: string, color?: string, style?: EpubHighlightStyle) {
		/* Always allow output */ 
		const content = buildNoteContent(text, cfiRange, color, style, autoInsert);
		if (autoInsert) {
			insertToEditorAndTrack(content);
		} else {
			copyTextToClipboard(content);
		}
	}

	function handleInsertToNote(
		text: string,
		cfiRange: string,
		color?: string,
		style?: EpubHighlightStyle
	) {
		outputNote(text, cfiRange, color, style);
		persistInlineHighlight(cfiRange, text, color, style);
	}

	function persistInlineHighlight(
		cfiRange: string,
		text: string,
		color?: string,
		style?: EpubHighlightStyle
	) {
		try {
			if (!book?.id) return;
			const key = 'weave-inline-hl-' + book.id;
			const raw = vaultStorage.getItem(key) || '[]';
			const arr = JSON.parse(raw);
			const createdTime = Date.now();
			const item = { cfiRange, color, style, text, commentText: '', createdTime, excerptId: generateBlockID() };
			const dedup = arr.filter((x: { cfiRange?: string }) => x.cfiRange !== cfiRange);
			dedup.push(item);
			vaultStorage.setItem(key, JSON.stringify(dedup));
			const optimistic: ReaderHighlight = {
				cfiRange,
				color,
				style,
				text,
				commentText: '',
				hasCommentDivider: false,
				createdTime,
				excerptId: item.excerptId,
				sourceFile: '__inline__',
				sourceRef: '',
				presentation: 'highlight',
			};
			pendingLoadedHighlights = mergeReaderHighlightsByIdentity(pendingLoadedHighlights, [
				optimistic,
			]);
			if (readerReady) {
				readerService.addHighlight(optimistic);
			}
			publishSidebarHighlights(pendingLoadedHighlights);
		} catch (_e) {}
	}


	function getHighlightStyleLabel(highlight: ReaderHighlight): string | null {
		switch (highlight.style) {
			case 'underline':
				return '下划线';
			case 'strikethrough':
				return '删除线';
			case 'wavy':
				return '波浪线';
			default:
				return null;
		}
	}

	function buildHighlightClickInfoFromDisplay(highlight: EpubDisplayHighlight): HighlightClickInfo {
		const style =
			highlight.noteTypeKey === 'underline' ||
			highlight.noteTypeKey === 'strikethrough' ||
			highlight.noteTypeKey === 'wavy'
				? highlight.noteTypeKey
				: undefined;
		return {
			cfiRange: highlight.cfiRange,
			color: highlight.color,
			style,
			text: highlight.text,
			commentText: highlight.commentText,
			hasCommentDivider: highlight.hasCommentDivider,
			sourceFile: highlight.sourceFile || '',
			sourceRef: highlight.sourceRef,
			excerptId: highlight.excerptId,
			createdTime: highlight.createdTime,
			presentation: 'highlight',
			rect: { top: 0, left: 0, width: 0, height: 0 },
		};
	}

	function handleAutoInsertSelection(
		text: string,
		cfiRange: string,
		color?: string,
		style?: EpubHighlightStyle
	) {
		// Always allow (gate removed)
		outputNote(text, cfiRange, color, style);
		persistInlineHighlight(cfiRange, text, color, style);
	}

	function requestSourceBookLocate(nav: BookLocateIntent): boolean {
		epubNavigation.requestBookLocate(nav);
		return true;
	}

	function requestBookLocate(nav: BookLocateIntent) {
		epubNavigation.requestBookLocate(nav);
	}

	function flushPendingLocateFromProps() {
		if (!hasSourceLocationCapability()) {
			return;
		}
		epubNavigation.flushPendingLocateFromProps(pendingLocate, pendingCfi, pendingText);
	}

	/** `linkTextHint` is only honored when embedded in link metadata, not callout body text. */
	function navigateToCfi(cfi: string, linkTextHint = '') {
		requestSourceBookLocate({
			cfi,
			text: linkTextHint,
			flashStyle: 'highlight',
			showLocateOverlay: true,
		});
	}

	function handleEpubNavigateEvent(e: Event) {
		const detail = (e as CustomEvent).detail;
		if (!detail || detail.filePath !== filePath) return;

		const nav = epubNavigation.buildLocateFromEventDetail(detail);
		if (nav) {
			requestSourceBookLocate(nav);
		}
	}

	function setupHighlightClickHandler() {
		readerService.onHighlightClick((info: HighlightClickInfo) => {
			footnotePreviewInfo = null;
			if (info.interactionTarget === 'comment-marker') {
				openCommentEditor(info);
				return;
			}
			if (info.interactionTarget === 'reference-badge') {
				return;
			}
			closeCommentEditor();
			highlightToolbarInfo = info;
		});
	}

	function setupScrolledChapterEndHandler() {
		scrolledChapterEndCleanup?.();
		scrolledChapterEndCleanup = null;
		if (typeof readerService.onScrolledChapterEndChange !== 'function') {
			return;
		}
		scrolledChapterEndCleanup = readerService.onScrolledChapterEndChange(() => {
			syncScrolledChapterNavVisibility();
		});
	}

	function setupFootnotePreviewHandler() {
		readerService.onFootnotePreview((info: ReaderFootnotePreviewInfo | null) => {
			logger.debugWithTag(
				'FootnoteDiag',
				`[FootnoteDiag] EpubReaderApp received footnote preview event hasInfo=${String(Boolean(info))} href=${info?.href || ''} textLength=${String(info?.text.length || 0)}`
			);
			if (!hasFootnotePreviewCapability()) {
				footnotePreviewInfo = null;
				return;
			}
			if (highlightToolbarInfo || commentEditorInfo) {
				footnotePreviewInfo = null;
				return;
			}
			footnotePreviewInfo = info;
		});
	}

	function openCommentEditor(info: HighlightClickInfo) {
// Always allow (gate removed)
		highlightToolbarInfo = null;
		footnotePreviewInfo = null;
		commentEditorInfo = info;
		commentEditorDraft = resolveCommentDraftFromMemory(info);
		commentEditorSaving = false;
		void hydrateCommentEditorDraft(info);
	}

	async function hydrateCommentEditorDraft(info: HighlightClickInfo) {
		const hydrated = await resolveCommentDraftFromSource(info);
		if (commentEditorInfo !== info) {
			return;
		}
		commentEditorDraft = hydrated;
		if (!hydrated.trim()) {
			return;
		}
		if (info.commentText === hydrated && info.hasCommentDivider) {
			return;
		}
		const refreshedHighlight: ReaderHighlight = {
			cfiRange: info.cfiRange,
			color: info.color,
			style: info.style,
			text: info.text,
			commentText: hydrated,
			hasCommentDivider: true,
			sourceFile: info.sourceFile,
			sourceRef: info.sourceRef,
			excerptId: info.excerptId,
			sourceLocators: info.sourceLocators,
			createdTime: info.createdTime,
			presentation: info.presentation,
		};
		readerService.addHighlight(refreshedHighlight);
		pendingLoadedHighlights = mergeReaderHighlightsByIdentity(
			pendingLoadedHighlights,
			[refreshedHighlight]
		);
	}

	function closeCommentEditor() {
		commentEditorInfo = null;
		commentEditorDraft = '';
		commentEditorSaving = false;
	}

	function syncAsActiveEpubDocumentIfActive(leaf: WorkspaceLeaf | null = app.workspace.activeLeaf): void {
		if (isActiveEpubReaderInstance(leaf)) {
			syncAsActiveEpubDocument();
		}
	}

	function handleWorkspaceActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		syncAsActiveEpubDocumentIfActive(leaf);
	}

	function syncAsActiveEpubDocument() {
		const activeFilePath = filePath?.trim() ? filePath : null;
		const canUseReadingProgress = hasReadingProgressCapability();
		const canUseExcerptNotes = hasExcerptNotesCapability();
		if (!activeFilePath) {
			epubActiveDocumentStore.clearActiveDocument();
			epubActiveDocumentStore.setSharedState({
				filePath: null,
				canUseReadingProgress,
				canUseExcerptNotes,
				excerptSettings,
				highlightViewSnapshotService: canUseExcerptNotes ? highlightViewSnapshotService : null,
				onDeleteBookmark: null,
				onDeleteHighlight: null,
				onSettingsClick: showSettingsMenu,
			});
			return;
		}

		epubActiveDocumentStore.setActiveDocument(activeFilePath);
		epubActiveDocumentStore.setSharedState({
			filePath: activeFilePath,
			readerService,
			highlightViewSnapshotService: canUseExcerptNotes ? highlightViewSnapshotService : null,
			book,
			canUseReadingProgress,
			canUseExcerptNotes,
			excerptSettings,
			annotationRevision,
			bookmarkRevision,
			progress: canUseReadingProgress ? readingProgress : 0,
			chapterTitle: readerService.getCurrentChapterTitle(),
			chapterHref: readerService.getCurrentChapterHref?.() || '',
			paginationInfo,
			onDeleteBookmark: deleteBookmarkById,
			onDeleteHighlight: canUseExcerptNotes ? deleteDisplayHighlight : null,
			onNavigate: requestBookLocate,
			onSettingsClick: showSettingsMenu,
			onSwitchBook,
		});
	}


	function findInlineHighlight(cfiRange: string) {
		try {
			if (!book?.id) return null;
			const key = 'weave-inline-hl-' + book.id;
			const raw = vaultStorage.getItem(key) || '[]';
			const arr = JSON.parse(raw);
			const nCfi = EpubLinkService.normalizeCfi(cfiRange);
			for (let i = 0; i < arr.length; i++) {
				if (EpubLinkService.normalizeCfi(arr[i].cfiRange) === nCfi) return { idx: i, item: arr[i], arr, key };
			}
		} catch (_e) {}
		return null;
	}
	function updateInlineHighlight(key: string, arr: any[]) {
		try { vaultStorage.setItem(key, JSON.stringify(arr)); } catch (_e) {}
	}

	function updateInlineHighlightFields(cfiRange: string, patch: Record<string, unknown>): void {
		try {
			if (!book?.id) return;
			const key = 'weave-inline-hl-' + book.id;
			const raw = vaultStorage.getItem(key) || '[]';
			const arr = JSON.parse(raw);
			const nCfi = EpubLinkService.normalizeCfi(cfiRange);
			let changed = false;
			for (let i = 0; i < arr.length; i++) {
				if (EpubLinkService.normalizeCfi(arr[i]?.cfiRange) === nCfi) {
					arr[i] = { ...arr[i], ...patch };
					changed = true;
					break;
				}
			}
			if (changed) {
				vaultStorage.setItem(key, JSON.stringify(arr));
			}
		} catch (_e) {}
	}

	async function handleHighlightDelete(
		info: HighlightClickInfo,
		options?: { quiet?: boolean }
	): Promise<boolean> {
		if (highlightDeleting) {
			return false;
		}
		highlightDeleting = true;
		try {
			return await performHighlightDelete(info, options);
		} finally {
			highlightDeleting = false;
		}
	}

	async function performHighlightDelete(
		info: HighlightClickInfo,
		options?: { quiet?: boolean }
	): Promise<boolean> {
		const quiet = options?.quiet === true;
		/* Always allow */ 
	const inline = findInlineHighlight(info.cfiRange);
	if (inline) {
		updateInlineHighlight(inline.key, inline.arr.filter((_, i) => i !== inline.idx));
	}
	readerService.removeHighlight(info.cfiRange);
	highlightToolbarInfo = null;
	if (!quiet) {
		new Notice('高亮已删除');
	}
	void reloadHighlights();
	return true;
}

	async function deleteDisplayHighlight(highlight: EpubDisplayHighlight, quiet = false): Promise<boolean> {
		return handleHighlightDelete(buildHighlightClickInfoFromDisplay(highlight), { quiet });
	}

	async function handleHighlightChangeColor(info: HighlightClickInfo, newColor: string) {
		if (!hasExcerptNotesCapability()) {
			return;
		}
		if (newColor === info.color) return;
		updateInlineHighlightFields(info.cfiRange, { color: newColor });
		readerService.addHighlight({
			cfiRange: info.cfiRange,
			color: newColor,
			style: info.style,
			text: info.text,
			commentText: info.commentText || '',
			hasCommentDivider: !!(info.commentText),
			createdTime: info.createdTime,
			sourceFile: '__inline__',
			sourceRef: '',
			presentation: 'highlight',
		});
		highlightToolbarInfo = null;
		void reloadHighlights();
	}

	async function handleHighlightChangeStyle(
		info: HighlightClickInfo,
		newStyle?: HighlightClickInfo['style']
	) {
		/* Always allow (gate removed) */
		if (newStyle === info.style) return;
		updateInlineHighlightFields(info.cfiRange, { style: newStyle });
		readerService.addHighlight({
			cfiRange: info.cfiRange,
			color: info.color,
			style: newStyle,
			text: info.text,
			commentText: info.commentText || '',
			hasCommentDivider: !!(info.commentText),
			createdTime: info.createdTime,
			sourceFile: '__inline__',
			sourceRef: '',
			presentation: 'highlight',
		});
		highlightToolbarInfo = null;
		void reloadHighlights();
	}

		function handleHighlightEditComment(info: HighlightClickInfo) {
		openCommentEditor(info);
	}

	async function saveHighlightComment() {
	// Always allow (gate removed)
		const info = commentEditorInfo;
		if (!info || commentEditorSaving) {
			return;
		}
		commentEditorSaving = true;
		try {
			const inline = findInlineHighlight(info.cfiRange);
			if (inline) {
				inline.item.commentText = commentEditorDraft;
				updateInlineHighlight(inline.key, inline.arr);
			}
			readerService.addHighlight({
				cfiRange: info.cfiRange,
				color: info.color || '',
				style: info.style,
				text: info.text,
				commentText: commentEditorDraft,
				hasCommentDivider: true,
				createdTime: info.createdTime,
				sourceFile: '__inline__',
				sourceRef: '',
				presentation: 'highlight',
			});
			new Notice('想法已保存');
			closeCommentEditor();
			void reloadHighlights();
		} finally {
			commentEditorSaving = false;
		}
	}

	async function handleHighlightCopyText(info: HighlightClickInfo) {
		const link = linkService.buildEpubLink(
			filePath,
			info.cfiRange,
			info.text,
			undefined,
			undefined,
			undefined,
			book?.sourceId,
			info.excerptId,
			{ includeText: false, includeChapter: false, preferCompactLocator: false }
		);
		await copyTextToClipboard(link);
		highlightToolbarInfo = null;
	}

	async function reloadHighlights(options?: HighlightReloadOptions) {
		if (!book || componentDisposed) return;
		const reloadToken = ++highlightReloadToken;
		highlightReloading = true;
		try {
			const allHighlights = await collectLocalStorageHighlights();
			if (componentDisposed || reloadToken !== highlightReloadToken) {
				return;
			}

			pendingLoadedHighlights = allHighlights;

			if (readerReady) {
				await readerService.applyHighlights(allHighlights);
			}
			publishSidebarHighlights(allHighlights);
		} catch (_e) {
			logger.warn('[EpubReaderApp] Failed to reload highlights:', _e);
		} finally {
			if (reloadToken === highlightReloadToken) {
				highlightReloading = false;
			}
		}
	}

	async function collectLocalStorageHighlights(): Promise<ReaderHighlight[]> {
		const allHighlights: ReaderHighlight[] = [];
		try {
			if (book?.id) {
				const key = 'weave-inline-hl-' + book.id;
				const raw = vaultStorage.getItem(key) || '[]';
				const inlineItems = JSON.parse(raw);
				if (Array.isArray(inlineItems)) {
					let migrated = false;
					for (const item of inlineItems) {
						if (!item || typeof item.cfiRange !== 'string') {
							continue;
						}
						if (!item.excerptId) {
							item.excerptId = generateBlockID();
							migrated = true;
						}
						allHighlights.push({
							cfiRange: item.cfiRange,
							color: item.color,
							style: item.style,
							text: item.text,
							commentText: item.commentText || '',
							hasCommentDivider: !!(item.commentText),
							createdTime: item.createdTime,
							excerptId: item.excerptId,
							sourceFile: '__inline__',
							sourceRef: '',
							presentation: 'highlight',
						});
					}
					if (migrated) {
						vaultStorage.setItem(key, JSON.stringify(inlineItems));
					}
				}
			}
		} catch (_e) {
			// ignore malformed inline highlight storage
		}
		return allHighlights;
	}

	async function migrateLegacyStoredLocations(options?: {
		requireReaderReady?: boolean;
		targetBook?: EpubBook | null;
	}) {
		const targetBook = options?.targetBook ?? book;
		const requireReaderReady = options?.requireReaderReady ?? true;
		if (!targetBook || (requireReaderReady && !readerReady)) {
			return;
		}
		if (migratedLocationBookIds.has(targetBook.id) || migratingLocationBookId === targetBook.id) {
			return;
		}

		migratingLocationBookId = targetBook.id;
		try {
			const summary = await locationMigrationService.migrateBookData(targetBook.id, filePath);
			migratedLocationBookIds.add(targetBook.id);
			migratingLocationBookId = null;

			if (summary.progressMigrated) {
				if (readerReady) {
					annotationRevision += 1;
					epubActiveDocumentStore.setSharedState({ annotationRevision });
				}
			}
		} catch (error) {
			logger.warn('[EpubReaderApp] Failed to migrate legacy EPUB locations:', error);
		} finally {
			if (migratingLocationBookId === targetBook.id) {
				migratingLocationBookId = null;
			}
		}
	}

	function trackHighlightSourceChanges() {
		// 已断开：高亮数据只由 local-storage.json 驱动，不再监听 vault 文件变化。
		// 保留空实现以兼容调用点（无 vault 事件注册，无性能开销）。
	}

	onMount(() => {
		const handleBookDisplayTitleChanged = (event: Event) => {
			const detail = (event as CustomEvent<{ filePath?: string; title?: string }>).detail;
			const changedPath = normalizePath(String(detail?.filePath || "").trim());
			const activePath = normalizePath(String(filePath || "").trim());
			const nextTitle = String(detail?.title || "").trim();
			if (!changedPath || changedPath !== activePath || !nextTitle || !book) {
				return;
			}
			book = {
				...book,
				metadata: {
					...book.metadata,
					title: nextTitle,
				},
			};
			onTitleChange?.(nextTitle);
			if (isActiveEpubReaderInstance()) {
				epubActiveDocumentStore.setSharedState({ book });
			}
		};
		window.addEventListener(
			EPUB_RUNTIME.events.bookDisplayTitleChanged,
			handleBookDisplayTitleChanged
		);
		componentDisposed = false;
		setupScrolledNavMetricsObserver();
		window.addEventListener('resize', scheduleScrolledNavLayoutSync);
		const loadReaderPreferences = async (): Promise<void> => {
			try {
				const [savedExcerptSettings, savedReaderSettings] = await Promise.all([
					storageService.loadExcerptSettings(),
					storageService.loadReaderSettings(),
				]);
				excerptSettings = savedExcerptSettings;
				excerptSettingsLoaded = true;
				epubActiveDocumentStore.setSharedState({
					excerptSettings: savedExcerptSettings,
				});
				const normalizedSettings = normalizeReaderSettings(savedReaderSettings);
				settings = normalizedSettings;
				readerService.setFootnoteClickAction?.(normalizedSettings.footnoteClickAction);
				onReaderSettingsLoaded?.(normalizedSettings);
				if (
					normalizedSettings.widthMode !== savedReaderSettings.widthMode
					|| normalizedSettings.layoutMode !== savedReaderSettings.layoutMode
					|| normalizedSettings.flowMode !== savedReaderSettings.flowMode
					|| normalizedSettings.footnoteClickAction !== savedReaderSettings.footnoteClickAction
				) {
					await storageService.saveReaderSettings(normalizedSettings);
				}
			} catch (error) {
				logger.warn('[EpubReaderApp] Failed to load reader settings:', error);
			}
		};
		excerptSettingsReady = loadReaderPreferences();
		const readerPreferencesReady = excerptSettingsReady;

		void (async () => {
			if (!filePath) {
				await readerPreferencesReady;
				book = null;
				loading = false;
				errorMsg = '';
				readerReady = false;
				onReadingReferencePointChange?.(null);
				onChapterTitleChange?.('');
				scheduleScrolledNavLayoutSync();
				return;
			}

			// Apply persisted flow/layout (and related reader prefs) before first render.
			await readerPreferencesReady;
			await loadBook();
		})();

		// Check global pending IR navigation (set by sidebar before this component mounts)
		const pending =
			(window as any)[EPUB_PENDING_NAVIGATION_KEY] ??
			(LEGACY_EPUB_PENDING_NAVIGATION_KEY
				? (window as any)[LEGACY_EPUB_PENDING_NAVIGATION_KEY]
				: null);
		if (pending && pending.filePath === filePath) {
			const nav = epubNavigation.buildLocateFromEventDetail(pending);
			if (nav) {
				requestSourceBookLocate(nav);
			}
		}

		flushPendingLocateFromProps();

		setupHighlightClickHandler();
		setupFootnotePreviewHandler();
		trackHighlightSourceChanges();
		setupScrolledChapterEndHandler();
		readerService.setBookEndAdvanceHandler?.(handleBookEndAdvanceAttempt);
		const activeLeafChangeRef = app.workspace.on(
			'active-leaf-change',
			handleWorkspaceActiveLeafChange
		);
		syncAsActiveEpubDocumentIfActive();

		if (rootEl) {
			rootEl.addEventListener('pointerdown', syncAsActiveEpubDocument);
			rootEl.addEventListener('focusin', syncAsActiveEpubDocument);
		}

		window.addEventListener(EXCERPT_SETTINGS_CHANGED_EVENT, handleGlobalExcerptSettingsChanged);
		window.addEventListener(EPUB_NAVIGATE_EVENT, handleEpubNavigateEvent);
		if (LEGACY_EPUB_NAVIGATE_EVENT) {
			window.addEventListener(LEGACY_EPUB_NAVIGATE_EVENT, handleEpubNavigateEvent);
		}

		onActionsReady?.({
			setAutoInsert: (enabled: boolean) => { autoInsert = enabled; },
			setLayoutMode: handleLayoutModeChange,
			setFlowMode: handleFlowModeChange,
			openTypographyPanel,
			getReaderSettings: () => settings,
			updateReaderSettings,
			navigateToCfi,
			addBookmark,
			canUseReadingProgress: hasReadingProgressCapability,
			canUseReadingReference: hasReadingReferenceCapability,
			canUseExcerptNotes: hasExcerptNotesCapability,
			canUseStyledExcerpts: hasStyledExcerptCapability,
			canUseFootnotePreview: hasFootnotePreviewCapability,
			saveReadingReferencePoint: hasReadingReferenceCapability() ? saveReadingReferencePoint : undefined,
			openReadingPositionMenu: openReadingReferencePointMenu,
			getReadingPositionAutoSaveEnabled: hasReadingProgressCapability()
				? () => getContinuousReadingPositionAutoSaveConfig().enabled
				: undefined,
			setReadingPositionAutoSaveEnabled: hasReadingProgressCapability()
				? setContinuousReadingPositionAutoSaveEnabled
				: undefined,
			getExcerptSettings: () => excerptSettings,
			updateExcerptSettings: applyAndPersistExcerptSettings,
			prevPage: handlePrevPage,
			nextPage: handleNextPage,
		});
		return () => {
			app.workspace.offref(activeLeafChangeRef);

			window.removeEventListener(
				EPUB_RUNTIME.events.bookDisplayTitleChanged,
				handleBookDisplayTitleChanged
			);
			componentDisposed = true;
			getBookSessionManager(app).releaseIfNoOpenLeaves(app, filePath);
			window.removeEventListener('resize', scheduleScrolledNavLayoutSync);
			if (scrolledNavSyncFrame) {
				cancelAnimationFrame(scrolledNavSyncFrame);
				scrolledNavSyncFrame = 0;
			}
			if (scrolledNavResizeObserver) {
				scrolledNavResizeObserver.disconnect();
				scrolledNavResizeObserver = null;
			}
			clearScrolledNavMetrics();
			activeBookLoadToken += 1;
			flushReaderStoreSync();
			if (rootEl) {
				rootEl.removeEventListener('pointerdown', syncAsActiveEpubDocument);
				rootEl.removeEventListener('focusin', syncAsActiveEpubDocument);
			}
			window.removeEventListener(EXCERPT_SETTINGS_CHANGED_EVENT, handleGlobalExcerptSettingsChanged);
			window.removeEventListener(EPUB_NAVIGATE_EVENT, handleEpubNavigateEvent);
			if (LEGACY_EPUB_NAVIGATE_EVENT) {
				window.removeEventListener(LEGACY_EPUB_NAVIGATE_EVENT, handleEpubNavigateEvent);
			}
			sourceLocateOverlay.clear();
			scrolledChapterEndCleanup?.();
			scrolledChapterEndCleanup = null;
			readerService.setBookEndAdvanceHandler?.(null);
			void persistCurrentReadingProgress(book).then((saved) => {
				if (saved) {
					bookshelfProgressChangedNotifier.flush();
				}
			}).finally(() => {
				bookshelfProgressChangedNotifier.dispose();
			});
			readerService.destroy();
			epubActiveDocumentStore.clearActiveDocument(filePath);
		};
	});

	onMount(() => {
		const unsubscribeTheme = UnifiedThemeManager.getInstance().addListener((result) => {
			hostTheme = result.isDark ? 'dark' : 'light';
		});
		window.addEventListener('mousedown', handleTypographyPointerDownOutside);
		return () => {
			unsubscribeTheme();
			window.removeEventListener('mousedown', handleTypographyPointerDownOutside);
			cancelPendingTapTurn();
			document.body.classList.remove('weave-epub-fullscreen');
		};
	});

	$effect(() => {
		const service = readerService;
		const enabled = isMobileReader() && settings.flowMode === 'paginated';
		const offTap = untrack(() => {
			service.setTapZonesEnabled?.(enabled);
			return service.onReaderTap?.((event) => handleReaderTap(event));
		});
		return () => {
			offTap?.();
		};
	});


	$effect(() => {
		const _flowMode = settings.flowMode;
		const _showScrolledSideNav = settings.showScrolledSideNav;
		const _widthMode = settings.widthMode;
		const _layoutMode = settings.layoutMode;
		const _viewport = viewportEl;
		const _readingReferencePoint = readingReferencePoint?.cfi;
		void _flowMode;
		void _showScrolledSideNav;		void _widthMode;
		void _layoutMode;
		void _viewport;
		void _readingReferencePoint;
		untrack(() => {
			setupScrolledNavMetricsObserver();
			scheduleScrolledNavLayoutSync();
		});
	});

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="epub-reader-root"
	data-theme={settings.theme}
	data-host-theme={hostTheme}
	data-flow={settings.flowMode}
	data-layout={settings.layoutMode}
	data-width={settings.widthMode}
	data-scrolled-side-nav={isDesktopScrolledSideNavVisible() ? 'visible' : 'hidden'}
	style={getReaderRootStyle()}
	bind:this={rootEl}
>
	{#if loading}
		<div class="epub-loading">
			<div class="epub-loading__panel">
				<EpubLoadingState
					message={bookLoadSlowWarning
						? buildBookLoadSlowWarningMessage(filePath)
						: '正在加载书籍…'}
				/>
				{#if bookLoadSlowWarning}
					<button
						type="button"
						class="epub-loading__cancel-btn"
						onclick={() => {
							void cancelSlowBookLoad();
						}}
					>
						{'关闭'}
					</button>
				{/if}
			</div>
		</div>
	{:else if errorMsg}
		<div class="epub-error">
			<span>{errorMsg}</span>
		</div>
	{:else if !filePath}
		<BookshelfView
			{app}
			{onSwitchBook}
			onClose={() => {}}
			onBack={() => {
				void onBackFromBookshelf?.();
			}}
			onSettingsClick={showSettingsMenu}
		/>
	{:else}
		<div
			class="epub-reader-viewport"
			bind:this={viewportEl}
		>
			{#if hasExcerptNotesCapability() && readerReady && highlightReloading}
				<div class="epub-reader-highlight-loading-overlay">
					<EpubLoadingState
						variant="compact"
						message={'正文高亮摘录正在加载中，请稍候…'}
					/>
				</div>
			{/if}
			<div class="epub-content-wrapper">
				<EpubReaderView
					{filePath}
					{book}
					{readerService}
					{storageService}
					{settings}
					{excerptSettings}
					canUseReadingProgress={hasReadingProgressCapability()}
					canUseExcerptNotes={hasExcerptNotesCapability()}
					getReadingPositionAutoSaveConfig={getContinuousReadingPositionAutoSaveConfig}
					onAutoReadingPositionSaved={handleAutoReadingPositionSaved}
					hasPendingNavigation={hasPendingBookLocate}
					onProgressChange={(p) => {
						syncReadingProgressDisplay(p);
						scheduleReaderStoreSync({
							progress: hasReadingProgressCapability() ? readingProgress : 0,
							chapterTitle: readerService.getCurrentChapterTitle(),
							chapterHref: readerService.getCurrentChapterHref?.() || '',
							paginationInfo,
						});
						syncScrolledChapterNavVisibility();
						scheduleScrolledNavLayoutSync();
					}}
					onPaginationChange={(info) => {
						paginationInfo = info;
						currentChapterIndex = readerService.getCurrentChapterIndex();
						scheduleReaderStoreSync({
							paginationInfo: info,
							chapterTitle: readerService.getCurrentChapterTitle(),
							chapterHref: readerService.getCurrentChapterHref?.() || '',
						});
						syncScrolledChapterNavVisibility();
						scheduleScrolledNavLayoutSync();
					}}
					onChapterChange={(title) => {
						currentChapterIndex = readerService.getCurrentChapterIndex();
						if (isActiveEpubReaderInstance()) {
							epubActiveDocumentStore.setSharedState({
								chapterTitle: String(title || '').trim(),
								chapterHref: readerService.getCurrentChapterHref?.() || '',
							});
						}
						syncScrolledChapterNavVisibility();
						onChapterTitleChange?.(String(title || '').trim());
					}}
					onReaderReady={() => {
						readerVersion++;
						readerReady = true;
						if (pendingLoadedHighlights) {
							void readerService.applyHighlights(pendingLoadedHighlights).then(() => {
								if (pendingLoadedHighlights && pendingLoadedHighlights.length > 0) {
									publishSidebarHighlights(pendingLoadedHighlights);
								}
							});
						} else if (book) {
							void reloadHighlights();
						}
						epubNavigation.flushPendingBookLocate();
						void migrateLegacyStoredLocations();
						syncScrolledChapterNavVisibility();
						scheduleScrolledNavLayoutSync();
					}}
					onRenderError={(message) => {
						logger.error('[EpubReaderApp] Reader view render error:', message);
						setError(message);
					}}
				/>
			</div>

		{#if showBottomNav() && useVerticalNav()}
				<BottomNav
					onPrev={handlePrevPage}
					onNext={handleNextPage}
					onJumpToPage={handleJumpToPage}
					currentPage={paginationInfo.currentPage}
					totalPages={paginationInfo.totalPages}
					vertical={true}
					statusText={getBottomNavStatusText()}
					statusDetail={getBottomNavStatusDetail()}
				/>
			{/if}

			{#if useVerticalNav() && showScrolledChapterNavActions}
				<div class="epub-scrolled-chapter-action-slot">
					<div class="epub-scrolled-chapter-action-start">
						{#if hasPrevChapter()}
							<button
								type="button"
								class="clickable-icon epub-nav-btn"
								title={'上一章节'}
								aria-label={'上一章节'}
								onclick={() => void handlePrevChapter()}
							>
								<span class="epub-nav-btn-icon" use:icon={'arrow-left'}></span>
								<span class="epub-nav-btn-label">{'上一章节'}</span>
							</button>
						{/if}
					</div>
					<div class="epub-scrolled-chapter-action-end">
						{#if hasNextChapter()}
							<button
								type="button"
								class="clickable-icon epub-nav-btn"
								title={'下一章节'}
								aria-label={'下一章节'}
								onclick={() => void handleNextChapter()}
							>
								<span class="epub-nav-btn-icon" use:icon={'arrow-right'}></span>
								<span class="epub-nav-btn-label">{'下一章节'}</span>
							</button>
						{/if}
					</div>
				</div>
			{/if}

			<EpubHighlightToolbar
				readerService={readerService}
				info={hasExcerptNotesCapability() ? highlightToolbarInfo : null}
				deleting={highlightDeleting}
				onDelete={handleHighlightDelete}
				onChangeColor={handleHighlightChangeColor}
				onChangeStyle={handleHighlightChangeStyle}
				onCopyText={handleHighlightCopyText}
				onEditComment={handleHighlightEditComment}
				onDismiss={() => highlightToolbarInfo = null}
			/>

			<EpubCommentEditorPopover
				open={hasExcerptNotesCapability() && commentEditorInfo !== null}
				info={hasExcerptNotesCapability() ? commentEditorInfo : null}
				{readerService}
				boundsEl={viewportEl}
				readingLockEl={readingViewportLockEl}
				draftText={commentEditorDraft}
				saving={commentEditorSaving}
				onDraftTextChange={(value) => commentEditorDraft = value}
				onSave={saveHighlightComment}
				onClose={closeCommentEditor}
			/>

			<EpubFootnotePreviewPopover
				info={footnotePreviewInfo}
				boundsEl={viewportEl}
			/>

			<SelectionToolbar
				{app}
				{readerService}
				{book}
				{readerVersion}
				boundsEl={viewportEl}
				{autoInsert}
				onInsertToNote={handleInsertToNote}
			/>

			{#if typographyPopoverOpen}
				<div class="epub-settings-float epub-glass-panel">
					<div class="epub-settings-row epub-settings-row--stack">
						<div class="epub-settings-row__heading">
							<span class="label">{'行高'}</span>
							<span class="epub-settings-value">{settings.lineHeight.toFixed(2)}</span>
						</div>
						<input
							class="epub-settings-range"
							type="range"
							min="1.2"
							max="2.4"
							step="0.01"
							value={settings.lineHeight}
							aria-label={'调节行高'}
							oninput={(event) => previewReaderLineHeight((event.currentTarget as HTMLInputElement).value)}
							onchange={persistCurrentReaderSettings}
						/>
					</div>
					<div class="epub-settings-row epub-settings-row--stack">
						<div class="epub-settings-row__heading">
							<span class="label">{'字距'}</span>
							<span class="epub-settings-value">{formatLetterSpacingValue(settings.letterSpacing)}</span>
						</div>
						<input
							class="epub-settings-range"
							type="range"
							min="-0.02"
							max="0.24"
							step="0.01"
							value={settings.letterSpacing}
							aria-label={'调节字距'}
							oninput={(event) => previewReaderLetterSpacing((event.currentTarget as HTMLInputElement).value)}
							onchange={persistCurrentReaderSettings}
						/>
					</div>
					<div class="epub-settings-row epub-settings-row--stack">
						<div class="epub-settings-row__heading">
							<span class="label">{'页边距'}</span>
							<span class="epub-settings-value">{Math.round(settings.pageMargin)}</span>
						</div>
						<input
							class="epub-settings-range"
							type="range"
							min="8"
							max="96"
							step="1"
							value={settings.pageMargin}
							aria-label={'调节页边距'}
							oninput={(event) => previewReaderPageMargin((event.currentTarget as HTMLInputElement).value)}
							onchange={persistCurrentReaderSettings}
						/>
					</div>
					<div class="epub-settings-row">
						<span class="label">{'宽度模式'}</span>
						<div class="epub-settings-mode-group">
							<button
								type="button"
							class="clickable-icon epub-settings-mode-btn"
							class:active={settings.widthMode === 'standard'}
							disabled={settings.layoutMode === 'double'}
							onclick={() => setReaderWidthMode('standard')}
						>{'标准'}</button>
						<button
							type="button"
							class="clickable-icon epub-settings-mode-btn"
							class:active={settings.widthMode === 'full'}
							disabled={settings.layoutMode === 'double'}
							onclick={() => setReaderWidthMode('full')}
						>{'宽版'}</button>
						<button
							type="button"
							class="clickable-icon epub-settings-mode-btn"
							class:active={settings.widthMode === 'fit'}
							onclick={() => setReaderWidthMode('fit')}
						>{'全宽'}</button>
						<button
							type="button"
							class="clickable-icon epub-settings-mode-btn"
							class:active={settings.widthMode === 'edge'}
							disabled={settings.layoutMode === 'double'}
							onclick={() => setReaderWidthMode('edge')}
						>{'贴边'}</button>
						</div>
					</div>
					<div class="epub-settings-row">
						<span class="label">{'翻页侧栏'}</span>
						<label class="epub-export-notes-popover__toggle-switch">
							<input
								type="checkbox"
								checked={settings.showScrolledSideNav}
								onchange={(event) => handleScrolledSideNavToggle((event.currentTarget as HTMLInputElement).checked)}
							/>
							<span class="epub-export-notes-popover__toggle-slider"></span>
						</label>
					</div>
					<div class="epub-settings-row">
						<span class="label">{'点击脚注序号'}</span>
						<div class="epub-settings-mode-group">
							{#if hasFootnotePreviewCapability()}
								<button
									type="button"
									class="clickable-icon epub-settings-mode-btn"
									class:active={settings.footnoteClickAction === 'preview'}
									onclick={() => setFootnoteClickAction('preview')}
								>{'显示浮窗'}</button>
							{/if}
							<button
								type="button"
								class="clickable-icon epub-settings-mode-btn"
								class:active={settings.footnoteClickAction === 'navigate'}
								onclick={() => setFootnoteClickAction('navigate')}
							>{'跳转原文'}</button>
						</div>
					</div>
					<div class="epub-settings-actions">
						<button type="button" class="epub-settings-reset" onclick={resetReaderTypographySettings}>{'恢复默认'}</button>
					</div>
				</div>
			{/if}

		</div>


	{/if}
</div>
