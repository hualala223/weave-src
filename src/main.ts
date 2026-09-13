import "./utils/group-by-compat";
import "./utils/blob-url-registry";
import { Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";

import { DEFAULT_EPUB_BOOKMARK_FOLDER } from "./config/epub-user-vault-folders";
import { isSupportedBookFile, isSupportedBookPath } from "./services/epub/book-format";
import {
	dispatchEpubBookshelfDataChanged,
	dispatchEpubBookshelfFullRefresh,
} from "./services/epub/bookshelf-data-events";
import {
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
	normalizeDataPath,
	normalizeWeaveParentFolder,
} from "./config/paths";
import { configureNavigationHub } from "./services/navigation/navigation-hub-access";
import { getBookSessionManager } from "./services/epub/session/book-session-manager-access";
import { syncLargeNavButtonStyle } from "./services/epub/epub-large-nav-style";
import {
	openEpubBookshelf,
	openEpubReader,
	registerEpubMarkdownPostProcessor,
	registerEpubProtocolHandler,
	registerEpubWorkspaceViews,
} from "./services/epub/epub-plugin-support";
import { disposeEpubExcerptHoverPreview } from "./services/epub/EpubLinkPostProcessor";
import { logger } from "./utils/logger";
import { perfSetSink } from "./utils/perf-probe";
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
	/** 统一的 weave 数据父目录（留空 = vault 根下的 weave/）。书签/高亮/阅读状态等均解析到 <父目录>/weave/ 下。 */
	weaveParentFolder: string;
	/** 统一数据路径（weave-data.json 所在目录，vault 相对路径）。 */
	dataPath: string;
	continuousReadingPositionAutoSaveEnabled: boolean;
	continuousReadingPositionAutoSavePages: number;
	selectionQuickCreateLastFolder: string;
	sourceNavigationOpenInNewTab: boolean;
	/** 笔记文档中悬停摘录块预览所在完整段落的浮框（默认开）。 */
	excerptParagraphHoverPreviewEnabled: boolean;
}

const DEFAULT_STANDALONE_EPUB_SETTINGS: StandaloneEpubPluginSettings = {
	enableDebugMode: false,
	enableLargeNavButtons: false,
	bookshelfAutoViewByLocationEnabled: false,
	bookshelfDisplayMode: DEFAULT_BOOKSHELF_DISPLAY_MODE,
	bookmarkFolder: DEFAULT_EPUB_BOOKMARK_FOLDER,
	weaveParentFolder: "",
	dataPath: DEFAULT_DATA_PATH,
	continuousReadingPositionAutoSaveEnabled:
		DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED,
	continuousReadingPositionAutoSavePages: DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	selectionQuickCreateLastFolder: "",
	sourceNavigationOpenInNewTab: true,
	excerptParagraphHoverPreviewEnabled: true,
};

type PersistedStandaloneEpubPluginSettings = Omit<
	StandaloneEpubPluginSettings,
	| "selectionQuickCreateLastFolder"
	| "bookshelfDisplayMode"
	| "bookshelfAutoViewByLocationEnabled"
>;

export type WeavePlugin = StandaloneEpubPlugin & Record<string, unknown>;

export default class StandaloneEpubPlugin extends Plugin {
	private workspaceViewsRegistered = false;
	private pendingBookshelfRefreshTimer: number | null = null;
	private epubStorageService: EpubStorageService | null = null;
	/** 诊断用：性能采样行缓冲区与落盘节流定时器（见 attachPerfLogSink）。 */
	private perfLogBuffer: string[] = [];
	private perfLogTimer: number | null = null;
	settings: StandaloneEpubPluginSettings = DEFAULT_STANDALONE_EPUB_SETTINGS;

	/**
	 * 诊断用（临时）：把探针的关键采样行写进插件目录下的 perf.log。
	 *
	 * 目的是替代「让用户在控制台敲命令」——挂上 sink 后探针不再往控制台输出，
	 * 因此也不引入 console 开销。写在 `.obsidian/plugins/<id>/` 下是因为该目录
	 * 不参与 vault 索引，不会触发 Obsidian 的重新索引。
	 * 采样行 3 秒合并写一次；任何异常都静默，绝不能影响插件本身。
	 */
	private attachPerfLogSink(): void {
		try {
			const adapter = this.app.vault.adapter;
			const logPath = normalizePath(
				`${this.app.vault.configDir}/plugins/${this.manifest.id}/perf.log`
			);
			void adapter
				.write(logPath, `# weave-perf session ${new Date().toISOString()}\n`)
				.catch(() => undefined);
			perfSetSink((line) => {
				this.perfLogBuffer.push(line);
				if (this.perfLogTimer !== null) {
					return;
				}
				this.perfLogTimer = window.setTimeout(() => {
					this.perfLogTimer = null;
					if (!this.perfLogBuffer.length) {
						return;
					}
					const pending = `${this.perfLogBuffer.join("\n")}\n`;
					this.perfLogBuffer = [];
					void adapter.append(logPath, pending).catch(() => undefined);
				}, 3000);
			});
		} catch {
			/* 诊断尽力而为 */
		}
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

	private getPersistedSettings(): PersistedStandaloneEpubPluginSettings {
		const {
			selectionQuickCreateLastFolder,
			bookshelfDisplayMode,
			bookshelfAutoViewByLocationEnabled,
			...persistedSettings
		} = this.settings;
		void selectionQuickCreateLastFolder;
		void bookshelfDisplayMode;
		void bookshelfAutoViewByLocationEnabled;
		return persistedSettings;
	}

	private getRememberedUiMemory() {
		return {
			selectionQuickCreateLastFolder: this.normalizeRememberedFolder(
				this.settings.selectionQuickCreateLastFolder
			),
		};
	}

	private hasLegacyRememberedUiKeys(value: unknown): boolean {
		if (!value || typeof value !== "object") {
			return false;
		}
		return ["selectionQuickCreateLastFolder"].some((key) => key in value);
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
		this.settings.weaveParentFolder = normalizeWeaveParentFolder(this.settings.weaveParentFolder);
		this.settings.dataPath = normalizeDataPath(this.settings.dataPath);
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			this.settings.selectionQuickCreateLastFolder
		);
		const hasLocalUiMemory = await this.getEpubStorageService().hasPluginUiMemory();
		const localUiMemory = await this.getEpubStorageService().loadPluginUiMemory();
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			hasLocalUiMemory
				? localUiMemory.selectionQuickCreateLastFolder
				: localUiMemory.selectionQuickCreateLastFolder || this.settings.selectionQuickCreateLastFolder
		);
		// v2：书架显示模式持久化到 weave-data.json 顶层（data.json 双写已停用）。
		const storedDisplayMode = await this.getEpubStorageService().loadShelfDisplayMode();
		if (storedDisplayMode) {
			this.settings.bookshelfDisplayMode = normalizeBookshelfDisplayMode(storedDisplayMode);
		}
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
		this.settings.weaveParentFolder = normalizeWeaveParentFolder(this.settings.weaveParentFolder);
		this.settings.dataPath = normalizeDataPath(this.settings.dataPath);
		this.settings.selectionQuickCreateLastFolder = this.normalizeRememberedFolder(
			this.settings.selectionQuickCreateLastFolder
		);
		await this.getEpubStorageService().savePluginUiMemory(this.getRememberedUiMemory());
		await this.getEpubStorageService().saveShelfDisplayMode(this.settings.bookshelfDisplayMode);
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
		this.attachPerfLogSink();
		syncLargeNavButtonStyle(this.settings.enableLargeNavButtons === true);
		await vaultStorage.initialize(this.app);
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
		this.registerWorkspaceViews();
		registerEpubMarkdownPostProcessor(this, this.app, {
			isHoverPreviewEnabled: () =>
				this.settings.excerptParagraphHoverPreviewEnabled !== false,
		});
		registerEpubProtocolHandler(this, this.app, "[Standalone EPUB Protocol]");
		this.registerBookshelfVaultRefreshBridge();
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
		perfSetSink(null);
		if (this.perfLogTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.perfLogTimer);
			this.perfLogTimer = null;
		}
		if (this.pendingBookshelfRefreshTimer !== null && typeof window !== "undefined") {
			window.clearTimeout(this.pendingBookshelfRefreshTimer);
			this.pendingBookshelfRefreshTimer = null;
		}
		disposeEpubExcerptHoverPreview(this.app);
		this.epubStorageService = null;
		resetEpubStorageServiceCache(this.app);
		logger.setDebugMode(false);
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
