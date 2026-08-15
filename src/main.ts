import "./utils/group-by-compat";
import "./utils/blob-url-registry";
import { Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";

import { EpubDataManagementModalObsidian } from "./components/epub/EpubDataManagementModalObsidian";
import { DEFAULT_EPUB_BOOKMARK_FOLDER } from "./config/epub-user-vault-folders";
import { isSupportedBookFile, isSupportedBookPath } from "./services/epub/book-format";
import {
	dispatchEpubBookshelfDataChanged,
	dispatchEpubBookshelfFullRefresh,
} from "./services/epub/bookshelf-data-events";
import {
	EPUB_RUNTIME,
	EpubStorageService,
	normalizeEpubBookmarkFolderPath,
	resetEpubStorageServiceCache,
} from "./services/epub";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED,
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	normalizeContinuousReadingPositionAutoSaveEnabled,
	normalizeContinuousReadingPositionAutoSavePages,
} from "./config/reading-position-auto-save";
import {
	DEFAULT_DATA_PATH,
	DEFAULT_HIGHLIGHT_STORAGE_PATH,
	normalizeDataPath,
	normalizeHighlightStoragePath,
	normalizeWeaveParentFolder,
} from "./config/paths";
import { configureNavigationHub } from "./services/navigation/navigation-hub-access";
import { getBookSessionManager } from "./services/epub/session/book-session-manager-access";
import { syncLargeNavButtonStyle } from "./services/epub/epub-large-nav-style";
import {
	registerEpubHost,
	unregisterEpubHost,
	type EpubHostCapabilities,
	type EpubWeaveOfficialAPI,
} from "./services/epub";
import { EpubExcerptOfficialApiService } from "./services/epub/EpubExcerptOfficialApiService";
import {
	openEpubBookshelf,
	openEpubReader,
	registerEpubMarkdownPostProcessor,
	registerEpubProtocolHandler,
	registerEpubWorkspaceViews,
} from "./services/epub/epub-plugin-support";
import { registerCanvasExcerptAnchorCacheWarmup } from "./services/epub/canvas-excerpt-anchor";
import { registerCanvasDirectionMenu } from "./services/epub/register-canvas-direction-menu";
import { registerCanvasExcerptAnchorMenu } from "./services/epub/register-canvas-excerpt-anchor-menu";
import { logger } from "./utils/logger";
import { vaultStorage } from "./utils/vault-local-storage";
import {
	DEFAULT_BOOKSHELF_DISPLAY_MODE,
	normalizeBookshelfDisplayMode,
	type BookshelfDisplayMode,
} from "./services/epub/bookshelf-display-mode";

interface StandaloneEpubPluginSettings {
	enableDebugMode: boolean;
	enableLargeNavButtons: boolean;
	bookshelfAutoViewByLocationEnabled: boolean;
	bookshelfDisplayMode: BookshelfDisplayMode;
	bookmarkFolder: string;
	highlightStoragePath: string;
	/** 统一的 weave 数据父目录（留空 = vault 根下的 weave/）。书签/高亮/阅读状态等均解析到 <父目录>/weave/ 下。 */
	weaveParentFolder: string;
	/** 统一数据路径（weave-data.json 所在目录，vault 相对路径）。 */
	dataPath: string;
	continuousReadingPositionAutoSaveEnabled: boolean;
	continuousReadingPositionAutoSavePages: number;
	lastSelectedIRDeckId: string;
	selectionQuickCreateLastFolder: string;
	sourceNavigationOpenInNewTab: boolean;
}

const DEFAULT_STANDALONE_EPUB_SETTINGS: StandaloneEpubPluginSettings = {
	enableDebugMode: false,
	enableLargeNavButtons: false,
	bookshelfAutoViewByLocationEnabled: false,
	bookshelfDisplayMode: DEFAULT_BOOKSHELF_DISPLAY_MODE,
	bookmarkFolder: DEFAULT_EPUB_BOOKMARK_FOLDER,
	highlightStoragePath: DEFAULT_HIGHLIGHT_STORAGE_PATH,
	weaveParentFolder: "",
	dataPath: DEFAULT_DATA_PATH,
	continuousReadingPositionAutoSaveEnabled:
		DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED,
	continuousReadingPositionAutoSavePages: DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	lastSelectedIRDeckId: "",
	selectionQuickCreateLastFolder: "",
	sourceNavigationOpenInNewTab: true,
};

type PersistedStandaloneEpubPluginSettings = Omit<
	StandaloneEpubPluginSettings,
	"lastSelectedIRDeckId" | "selectionQuickCreateLastFolder"
>;

export type WeavePlugin = StandaloneEpubPlugin & Record<string, unknown>;

export default class StandaloneEpubPlugin extends Plugin implements EpubHostCapabilities {
	private workspaceViewsRegistered = false;
	private pendingBookshelfRefreshTimer: number | null = null;
	private epubStorageService: EpubStorageService | null = null;
	private epubOfficialApiService: EpubExcerptOfficialApiService | null = null;
	settings: StandaloneEpubPluginSettings = DEFAULT_STANDALONE_EPUB_SETTINGS;

	/** Weave 宿主可通过 `app.plugins.getPlugin("weave-epub-reader")` 调用 */
	openDataManagementModal(): void {
		new EpubDataManagementModalObsidian(this.app, {
			plugin: this,
		}).open();
	}

	private syncDebugSettings(): void {
		this.settings.enableDebugMode = this.settings.enableDebugMode === true;
		logger.setDebugMode(this.settings.enableDebugMode);
	}

	private syncBookshelfDisplaySettings(): void {
		const normalizedMode = normalizeBookshelfDisplayMode(this.settings.bookshelfDisplayMode);
		this.settings.bookshelfDisplayMode =
			this.settings.bookshelfDisplayMode == null
				? this.settings.bookshelfAutoViewByLocationEnabled !== false
					? DEFAULT_BOOKSHELF_DISPLAY_MODE
					: "list"
				: normalizedMode;
		this.settings.bookshelfAutoViewByLocationEnabled =
			this.settings.bookshelfDisplayMode === DEFAULT_BOOKSHELF_DISPLAY_MODE;
	}

	private syncReadingPositionAutoSaveSettings(): void {
		this.settings.continuousReadingPositionAutoSaveEnabled =
			normalizeContinuousReadingPositionAutoSaveEnabled(
				this.settings.continuousReadingPositionAutoSaveEnabled
			);
		this.settings.continuousReadingPositionAutoSavePages =
			normalizeContinuousReadingPositionAutoSavePages(
				this.settings.continuousReadingPositionAutoSavePages
			);
	}

	getEpubStorageService(): EpubStorageService {
		if (!this.epubStorageService) {
			this.epubStorageService = new EpubStorageService(this.app);
		}
		return this.epubStorageService;
	}

	getOfficialAPI(): EpubWeaveOfficialAPI {
		if (!this.epubOfficialApiService) {
			this.epubOfficialApiService = new EpubExcerptOfficialApiService(this.app);
		}
		return this.epubOfficialApiService;
	}

	private getPersistedSettings(): PersistedStandaloneEpubPluginSettings {
		const {
			lastSelectedIRDeckId,
			selectionQuickCreateLastFolder,
			...persistedSettings
		} = this.settings;
		void lastSelectedIRDeckId;
		void selectionQuickCreateLastFolder;
		return persistedSettings;
	}

	private getRememberedUiMemory() {
		return {
			lastSelectedIRDeckId: String(this.settings.lastSelectedIRDeckId || "").trim(),
			selectionQuickCreateLastFolder: this.normalizeRememberedFolder(
				this.settings.selectionQuickCreateLastFolder
			),
		};
	}

	private hasLegacyRememberedUiKeys(value: unknown): boolean {
		if (!value || typeof value !== "object") {
			return false;
		}
		return ["lastSelectedIRDeckId", "selectionQuickCreateLastFolder"].some((key) => key in value);
	}

	private normalizeLoadedSettings(raw: unknown): Partial<PersistedStandaloneEpubPluginSettings> {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return {};
		}
		return raw;
	}

	private async persistSettingsData(): Promise<void> {
		await this.saveData(this.getPersistedSettings());
	}

	async loadSettings(): Promise<void> {
		const loadedData = this.normalizeLoadedSettings(await this.loadData());
		this.settings = {
			...DEFAULT_STANDALONE_EPUB_SETTINGS,
			...loadedData,
		};
		this.settings.bookmarkFolder =
			normalizeEpubBookmarkFolderPath(this.settings.bookmarkFolder) || DEFAULT_EPUB_BOOKMARK_FOLDER;
		this.settings.highlightStoragePath = normalizeHighlightStoragePath(this.settings.highlightStoragePath);
		this.settings.weaveParentFolder = normalizeWeaveParentFolder(this.settings.weaveParentFolder);
		this.settings.dataPath = normalizeDataPath(this.settings.dataPath);
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			this.settings.selectionQuickCreateLastFolder
		);
		this.settings.lastSelectedIRDeckId = String(this.settings.lastSelectedIRDeckId || "").trim();
		const hasLocalUiMemory = await this.getEpubStorageService().hasPluginUiMemory();
		const localUiMemory = await this.getEpubStorageService().loadPluginUiMemory();
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			hasLocalUiMemory
				? localUiMemory.selectionQuickCreateLastFolder
				: localUiMemory.selectionQuickCreateLastFolder || this.settings.selectionQuickCreateLastFolder
		);
		this.settings.lastSelectedIRDeckId =
			String(
				hasLocalUiMemory
					? localUiMemory.lastSelectedIRDeckId
					: localUiMemory.lastSelectedIRDeckId || this.settings.lastSelectedIRDeckId || ""
			).trim();
		this.syncDebugSettings();
		this.syncBookshelfDisplaySettings();
		this.syncReadingPositionAutoSaveSettings();
		this.settings.sourceNavigationOpenInNewTab = this.settings.sourceNavigationOpenInNewTab !== false;
		if (this.hasLegacyRememberedUiKeys(loadedData)) {
			await this.getEpubStorageService().savePluginUiMemory(this.getRememberedUiMemory());
			await this.persistSettingsData();
		}
	}

	async saveSettings(): Promise<void> {
		this.syncDebugSettings();
		this.syncBookshelfDisplaySettings();
		this.syncReadingPositionAutoSaveSettings();
		this.settings.bookmarkFolder =
			normalizeEpubBookmarkFolderPath(this.settings.bookmarkFolder) || DEFAULT_EPUB_BOOKMARK_FOLDER;
		this.settings.highlightStoragePath = normalizeHighlightStoragePath(this.settings.highlightStoragePath);
		this.settings.weaveParentFolder = normalizeWeaveParentFolder(this.settings.weaveParentFolder);
		this.settings.dataPath = normalizeDataPath(this.settings.dataPath);
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			this.settings.selectionQuickCreateLastFolder
		);
		this.settings.lastSelectedIRDeckId = String(this.settings.lastSelectedIRDeckId || "").trim();
		await this.getEpubStorageService().savePluginUiMemory(this.getRememberedUiMemory());
		await this.persistSettingsData();
	}

	private normalizeRememberedFolder(folderPath?: string | null): string {
		const raw = String(folderPath || "").trim();
		if (!raw) {
			return "";
		}
		if (raw === "/" || raw === ".") {
			return "/";
		}
		return normalizePath(raw);
	}

	private async persistPreferenceSettings(): Promise<void> {
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			this.settings.selectionQuickCreateLastFolder
		);
		this.settings.lastSelectedIRDeckId = String(this.settings.lastSelectedIRDeckId || "").trim();
		await this.getEpubStorageService().savePluginUiMemory(this.getRememberedUiMemory());
		await this.persistSettingsData();
	}

	private queueBookshelfRefreshEvent(fullRefresh = true): void {
		if (typeof window === "undefined") {
			return;
		}
		if (this.pendingBookshelfRefreshTimer !== null) {
			window.clearTimeout(this.pendingBookshelfRefreshTimer);
		}
		this.pendingBookshelfRefreshTimer = window.setTimeout(() => {
			this.pendingBookshelfRefreshTimer = null;
			if (fullRefresh) {
				dispatchEpubBookshelfFullRefresh();
				return;
			}
			dispatchEpubBookshelfDataChanged();
		}, 120);
	}

	private registerBookshelfVaultRefreshBridge(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (isSupportedBookFile(file)) {
					this.queueBookshelfRefreshEvent(true);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (isSupportedBookFile(file)) {
					this.queueBookshelfRefreshEvent(false);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (isSupportedBookPath(file.path)) {
					this.queueBookshelfRefreshEvent(true);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (isSupportedBookPath(oldPath) || isSupportedBookFile(file)) {
					this.queueBookshelfRefreshEvent(true);
				}
			})
		);
	}

	private registerWorkspaceViews(): void {
		if (this.workspaceViewsRegistered) {
			return;
		}

		registerEpubWorkspaceViews(
			this,
			"[Standalone EPUB]",
			'独立 EPUB 插件'
		);
		this.workspaceViewsRegistered = true;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		syncLargeNavButtonStyle(this.settings.enableLargeNavButtons === true);
		await vaultStorage.initialize(this.app);
		registerEpubHost(this.app, this);
		configureNavigationHub(this.app, {
			getSourceNavigationOpenInNewTab: () => this.settings.sourceNavigationOpenInNewTab !== false,
			getEnableDebugMode: () => this.settings.enableDebugMode === true,
		});
		getBookSessionManager(this.app, {
			cardSyncDedupeMs: 600,
			getEnableDebugMode: () => this.settings.enableDebugMode === true,
		});
			const { EpubSettingsTab } = await import("./components/settings/EpubSettingsTab");
		this.addSettingTab(new EpubSettingsTab(this.app, this));
		registerCanvasExcerptAnchorMenu(this);
		registerCanvasDirectionMenu(this);
		registerCanvasExcerptAnchorCacheWarmup(this);
		this.registerWorkspaceViews();
		registerEpubMarkdownPostProcessor(this, this.app);
		registerEpubProtocolHandler(this, this.app, "[Standalone EPUB Protocol]");
		this.registerBookshelfVaultRefreshBridge();
		const {
			bootstrapEpubAnnotationIndex,
			scheduleEpubAnnotationIndexWarmup,
		} = await import("./services/epub/epub-annotation-index");
		this.registerEvent(
			this.app.workspace.on("layout-ready", () => {
				bootstrapEpubAnnotationIndex(this.app);
			})
		);
		scheduleEpubAnnotationIndexWarmup(this.app);
		this.registerDomEvent(
			window,
			EPUB_RUNTIME.events.bookshelfDataChanged as keyof WindowEventMap,
			() => {
				scheduleEpubAnnotationIndexWarmup(this.app, 8_000);
			}
		);
		this.addRibbonIcon("library", '我的书架', () => {
			void this.openEpubBookshelf();
		});

		this.addCommand({
			id: "open-epub-bookshelf",
			name: '我的书架',
			callback: () => {
				void this.openEpubBookshelf();
			},
		});
		this.addCommand({
			id: "open-active-epub-reader",
			name: '打开 EPUB 阅读器',
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				const canOpen = activeFile instanceof TFile && isSupportedBookFile(activeFile);
				if (!checking && canOpen) {
					void this.openEpubReader(activeFile.path);
				}
				return canOpen;
			},
		});
	}

	onunload(): void {
		if (this.pendingBookshelfRefreshTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.pendingBookshelfRefreshTimer);
			this.pendingBookshelfRefreshTimer = null;
		}
		this.epubStorageService = null;
		resetEpubStorageServiceCache(this.app);
		logger.setDebugMode(false);
		unregisterEpubHost(this.app);
	}

	private async openEpubBookshelf(): Promise<void> {
		await openEpubBookshelf(
			this.app,
			"[Standalone EPUB]",
			`${'我的书架'}${'打开失败'}`
		);
	}

	async openEpubReader(filePath: string): Promise<void> {
		await openEpubReader(
			this.app,
			filePath,
			"[Standalone EPUB]",
			'未找到对应的书籍文件',
			'打开书籍失败'
		);
	}
}
