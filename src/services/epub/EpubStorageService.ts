import { type App, TAbstractFile, TFile } from "obsidian";
import { Platform, normalizePath } from "obsidian";
import {
	getPluginPathsById,
	LEGACY_PATHS,
	getV2PathsFromApp,
	toVaultAdapterPath,
	DEFAULT_DATA_PATH,
	normalizeDataPath,
} from "../../config/paths";
import { CURRENT_PLUGIN_ID } from "../../config/plugin-runtime";
import { DirectoryUtils } from "../../utils/directory-utils";
import { logger } from "../../utils/logger";
import {
	getDefaultEpubReaderSettings,
	normalizeEpubReaderSettingsForDevice,
	type EpubReaderSettingsDeviceKind,
} from "./reader-settings";
import {
	isSupportedBookFile,
	isSupportedBookPath,
	stripSupportedBookExtension,
} from "./book-format";
import {
	isVisibleVaultBookPath,
	resolveSupportedBookFile,
	resolveSupportedBookFilePath as resolveCanonicalSupportedBookFilePath,
} from "./epub-vault-path";
import { EpubBookmarkService } from "./EpubBookmarkService";
import { normalizeReadingPaceStats } from "./reading-pace";
import type {
	BookMetadata,
	EpubBook,
	EpubLastOpenBookmark,
	EpubParagraphModeReadingPosition,
	EpubReadingReferencePoint,
	EpubReaderSettings,
	ReadingPosition,
	ReadingStats,
} from "./types";
import { getEpubRuntime } from "./epub-runtime";
import { EpubProgressStore, normalizePendingProgressPayload } from "./epub-progress-store";
import {
	DEFAULT_EPUB_EXCERPT_SETTINGS,
	type EpubExcerptSettings,
} from "./epub-excerpt-settings";
import {
	normalizeBookMetadata,
	normalizeExcerptSettings,
	normalizeLastOpenBookmark,
	normalizeLegacySourceIds,
	normalizePluginUiMemory,
	normalizeReadingReferencePoint,
} from "./epub-local-data-normalize";
import type { EpubPluginUiMemory } from "./epub-local-data-types";
export type { EpubPluginUiMemory } from "./epub-local-data-types";
import type { EpubBookshelfMembershipEntry } from "./epub-bookshelf-membership-store";
import {
	createBookshelfPlaylistId,
	normalizeBookshelfPlaylistBookPaths,
	type EpubBookshelfPlaylist,
} from "./epub-bookshelf-playlist-store";
import { getSchemaV2Store, type SchemaV2Store } from "./schema-v2-store";
import {
	createEmptyEpubBookNotes,
	toEpubBook,
	toEpubBookAggregate,
} from "./epub-v2-book-mapping";
import type { EpubStoredHighlight, WeaveUiMemory } from "./schema-v2";

export interface EpubBookshelfSettings {
	lastScanAt?: number;
}

export interface EpubBookshelfIndexEntry {
	path: string;
	name: string;
	folder: string;
	size: number;
	addedAt?: number;
	customCoverPath?: string;
}

export interface EpubScanIndexEntry extends EpubBookshelfIndexEntry {
	mtime: number;
	coverImage?: string;
}

/** weave-data.json `shelf` 领域分区（书架/扫描索引）。 */
export interface EpubShelfSectionData {
	scanIndex?: EpubScanIndexEntry[];
}

/** weave-data.json `traceability` 领域分区（溯源注册表）。 */
export interface EpubTraceabilitySectionData {
	sourceRegistry?: EpubSourceRegistryEntry[];
}

export type { EpubBookshelfMembershipEntry };

export type { EpubBookshelfPlaylist };

export interface EpubDeleteTrackedBookResult {
	deletedFilePath: string | null;
	fileDeleted: boolean;
	removedScanEntries: number;
	removedMembershipEntries: number;
	removedBookIds: string[];
}

export interface EpubSourceRegistryEntry {
	sourceId: string;
	filePath: string;
	sourceFingerprint?: string;
	legacySourceIds?: string[];
	sourceSize?: number;
	sourceMtime?: number;
	lastSeenAt: number;
	lastKnownPath?: string;
}

export const DEFAULT_EPUB_BOOKSHELF_SETTINGS: EpubBookshelfSettings = {
	lastScanAt: 0,
};

export class EpubStorageService {
	private app: App;
	private basePath: string;
	private localPluginId: string;
	private _progressDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _pendingProgress: {
		bookId: string;
		position: ReadingPosition;
		readingStats?: ReadingStats;
	} | null = null;
	private _booksCache: Record<string, EpubBook> | null = null;
	private _booksCacheHydrated = false;
	private _booksCacheHydrationTask: Promise<void> | null = null;
	private _booksWriteLock: Promise<void> = Promise.resolve();
	private _bookStateWriteLocks = new Map<string, Promise<void>>();
	private bookIdAliasMap = new Map<string, string>();
	private automaticMigrationCompleted = false;
	private inflightAutomaticMigration: Promise<void> | null = null;
	private legacyStorageRetired = false;
	private bookmarkService: EpubBookmarkService | null = null;

	constructor(app: App) {
		this.app = app;
		const runtime = getEpubRuntime();
		this.localPluginId = runtime.pluginDirName;
		// 尊重用户配置的 weave 父目录（weaveParentFolder），避免数据散落到 vault 根 weave/
		this.basePath = getV2PathsFromApp(app).ir.epub;
	}

	getApp(): App {
		return this.app;
	}

	private getBookmarkService(): EpubBookmarkService {
		if (!this.bookmarkService) {
			this.bookmarkService = new EpubBookmarkService(this.app);
		}
		return this.bookmarkService;
	}

	/** 生效的 weave-data.json 数据路径（读取插件设置 dataPath，回退默认）。 */
	private resolveDataPath(): string {
		const plugin = (this.app as unknown as {
			plugins?: {
				getPlugin?: (pluginId: string) => {
					settings?: { dataPath?: string };
				} | null | undefined;
			};
		})?.plugins?.getPlugin?.(CURRENT_PLUGIN_ID);
		return normalizeDataPath(plugin?.settings?.dataPath) || DEFAULT_DATA_PATH;
	}

	private getV2Store(): SchemaV2Store {
		return getSchemaV2Store(this.app, () => this.resolveDataPath());
	}

	async ensureDirectories(): Promise<void> {
		const store = this.getV2Store();
		await DirectoryUtils.ensureDirForFile(this.app.vault.adapter, store.getFilePath());
	}

	async loadBooks(options?: { hydrateStates?: boolean }): Promise<Record<string, EpubBook>> {
		const shouldHydrateStates = options?.hydrateStates !== false;
		await this.ensureAutomaticDataMigrations();
		if (this._booksCache) {
			if (shouldHydrateStates) {
				await this.ensureBooksCacheHydrated();
			}
			return this._booksCache;
		}
		const aggregates = await this.getV2Store().getBooks();
		const books: Record<string, EpubBook> = {};
		for (const aggregate of aggregates) {
			books[aggregate.id] = toEpubBook(aggregate);
		}
		this._booksCache = books;
		if (shouldHydrateStates) {
			await this.ensureBooksCacheHydrated();
		}
		return books;
	}

	private async ensureBooksCacheHydrated(): Promise<void> {
		if (this._booksCacheHydrated || !this._booksCache) {
			return;
		}

		if (!this._booksCacheHydrationTask) {
			this._booksCacheHydrationTask = this.hydrateBookStates(this._booksCache)
				.then(() => {
					this._booksCacheHydrated = true;
				})
				.finally(() => {
					this._booksCacheHydrationTask = null;
				});
		}

		await this._booksCacheHydrationTask;
	}

	private async writeBooksWithLock(books: Record<string, EpubBook>): Promise<void> {
		const doWrite = async () => {
			this._booksCache = books;
			this._booksCacheHydrated = false;
			this._booksCacheHydrationTask = null;
			const store = this.getV2Store();
			for (const book of Object.values(books)) {
				const existing = await store.getBook(book.id);
				store.upsertBook(
					toEpubBookAggregate(book, {
						notes: existing?.notes,
						lastPosition: existing?.reading?.lastPosition,
						ui: existing?.ui,
					})
				);
			}
		};
		this._booksWriteLock = this._booksWriteLock.then(doWrite, doWrite);
		await this._booksWriteLock;
	}

	private getLocalReaderStateRoot(): string {
		return this.getPluginAdapterPath(
			`${
				getPluginPathsById(this.app, this.localPluginId).state.incrementalReading.readerState
			}/epub`
		);
	}

	private getPluginAdapterPath(relativePath: string): string {
		return toVaultAdapterPath(this.app, normalizePath(relativePath));
	}

	private getUnifiedLocalDataPath(): string {
		return this.getPluginAdapterPath(
			getPluginPathsById(this.app, this.localPluginId).state.epubLocalState
		);
	}

	private getLegacyUnifiedLocalDataPaths(): string[] {
		const targetPath = this.getUnifiedLocalDataPath();
		return Array.from(
			new Set([
				normalizePath(
					`${
						getPluginPathsById(this.app, this.localPluginId).state.incrementalReading
							.epubReaderData
					}`
				),
			])
		).filter((path) => Boolean(path) && path !== targetPath);
	}

	private getLocalReaderArtifactsRoot(): string {
		return this.getPluginAdapterPath(
			`${
				getPluginPathsById(this.app, this.localPluginId).cache.incrementalReading
					.readerArtifacts
			}/epub`
		);
	}

	private getLegacyEpubBasePaths(): string[] {
		return Array.from(
			new Set([normalizePath(this.basePath), normalizePath(LEGACY_PATHS.epubReading)])
		).filter(Boolean);
	}

	private getCurrentDeviceKind(): EpubReaderSettingsDeviceKind {
		return Platform.isMobile ? "mobile" : "desktop";
	}

	private normalizePluginUiMemory(value: unknown): EpubPluginUiMemory {
		return normalizePluginUiMemory(value);
	}

	private normalizeLastOpenBookmark(value: unknown): EpubLastOpenBookmark | null {
		return normalizeLastOpenBookmark(value);
	}

	private normalizeReadingReferencePoint(value: unknown): EpubReadingReferencePoint | null {
		return normalizeReadingReferencePoint(value);
	}

	private normalizeLegacySourceIds(value: unknown, canonicalSourceId?: string): string[] | undefined {
		return normalizeLegacySourceIds(value, canonicalSourceId);
	}

	private normalizeBookMetadata(value: unknown): BookMetadata | null {
		return normalizeBookMetadata(value);
	}

	private resolveBookIdAlias(bookId: string): string {
		const normalizedBookId = String(bookId || "").trim();
		return this.bookIdAliasMap.get(normalizedBookId) || normalizedBookId;
	}

	private async resolveCanonicalBookId(bookId: string): Promise<string> {
		await this.ensureAutomaticDataMigrations();
		return this.resolveBookIdAlias(bookId);
	}

	private async ensureAutomaticDataMigrations(): Promise<void> {
		if (this.automaticMigrationCompleted) {
			return;
		}
		if (this.inflightAutomaticMigration) {
			await this.inflightAutomaticMigration;
			return;
		}

		const migrationPromise = (async () => {
			await this.retireLegacyStorageFiles();
			this._booksCache = null;
			this._booksCacheHydrated = false;
			this._booksCacheHydrationTask = null;
			this.automaticMigrationCompleted = true;
		})();

		this.inflightAutomaticMigration = migrationPromise;
		try {
			await migrationPromise;
		} finally {
			if (this.inflightAutomaticMigration === migrationPromise) {
				this.inflightAutomaticMigration = null;
			}
		}
	}

	private buildShelfOnlyBookFromScanEntry(entry: EpubScanIndexEntry): EpubBook {
		const filePath = normalizePath(entry.path || "");
		return {
			id: this.buildStableBookId({ filePath }),
			filePath,
			metadata: {
				title:
					String(entry.name || "").trim() ||
					stripSupportedBookExtension(filePath.split("/").pop() || "") ||
					"书籍",
				author: "",
				chapterCount: 0,
			},
			currentPosition: { chapterIndex: 0, cfi: "", percent: 0 },
			readingStats: { totalReadTime: 0, lastReadTime: 0, createdTime: 0 },
		};
	}

	private buildBookshelfIndexEntriesFromBooks(
		books: Record<string, EpubBook>
	): EpubBookshelfIndexEntry[] {
		return Object.values(books).map((book) => {
			const file = this.app.vault.getAbstractFileByPath(book.filePath);
			const size = file instanceof TFile ? file.stat.size : 0;
			const normalizedPath = normalizePath(book.filePath || "");
			const slashIndex = normalizedPath.lastIndexOf("/");
			return {
				path: normalizedPath,
				name:
					stripSupportedBookExtension(normalizedPath.split("/").pop() || "") ||
					book.metadata.title ||
					"书籍",
				folder: slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) || "/" : "/",
				size,
				addedAt: typeof book.readingStats?.createdTime === "number" ? book.readingStats.createdTime : 0,
			};
		});
	}

	private toBookshelfIndexEntry(
		entry: EpubScanIndexEntry,
		addedAt = 0,
		customCoverPath?: string
	): EpubBookshelfIndexEntry {
		return {
			path: entry.path,
			name: entry.name,
			folder: entry.folder,
			size: entry.size,
			addedAt,
			customCoverPath,
		};
	}

	private isEpubPath(filePath: string): boolean {
		const normalizedPath = normalizePath(filePath || "");
		return isSupportedBookPath(normalizedPath);
	}

	private isEpubFile(file: TAbstractFile | null | undefined): boolean {
		return isSupportedBookFile(file);
	}

	private isPathWithinFolder(filePath: string, folderPath: string): boolean {
		if (!folderPath) {
			return true;
		}

		const normalizedFilePath = normalizePath(filePath || "");
		return normalizedFilePath.startsWith(`${folderPath}/`);
	}

	private normalizeScanFolderScope(folderPath?: string): string {
		const rawFolderPath = String(folderPath || "").trim();
		if (!rawFolderPath || rawFolderPath === "/" || rawFolderPath === ".") {
			return "";
		}

		const normalizedFolderPath = normalizePath(rawFolderPath);
		if (!normalizedFolderPath || normalizedFolderPath === "/" || normalizedFolderPath === ".") {
			return "";
		}

		return normalizedFolderPath;
	}

	private collectEpubPathsFromVaultIndex(folderPath?: string): string[] {
		const normalizedFolder = this.normalizeScanFolderScope(folderPath);

		return this.app.vault
			.getFiles()
			.filter(
				(file) =>
					this.isEpubFile(file) &&
					isVisibleVaultBookPath(file.path, this.app.vault.configDir) &&
					this.isPathWithinFolder(file.path, normalizedFolder)
			)
			.map((file) => normalizePath(file.path));
	}

	private async createScanIndexEntryFromPath(filePath: string): Promise<EpubScanIndexEntry> {
		const resolvedFile = resolveSupportedBookFile(this.app, filePath);
		const normalizedPath = resolvedFile?.path || normalizePath(filePath || "");
		const file = resolvedFile || this.app.vault.getAbstractFileByPath(normalizedPath);
		const slashIndex = normalizedPath.lastIndexOf("/");

		let size = file instanceof TFile ? file.stat.size : 0;
		let mtime = file instanceof TFile ? file.stat.mtime : 0;

		if (
			(size === 0 || mtime === 0) &&
			typeof (
				this.app.vault.adapter as {
					stat?: (path: string) => Promise<{ size?: number; mtime?: number }>;
				}
			).stat === "function"
		) {
			try {
				const stat = await (
					this.app.vault.adapter as {
						stat: (path: string) => Promise<{ size?: number; mtime?: number }>;
					}
				).stat(normalizedPath);
				if (typeof stat?.size === "number") {
					size = stat.size;
				}
				if (typeof stat?.mtime === "number") {
					mtime = stat.mtime;
				}
			} catch {
				// noop
			}
		}

		return {
			path: normalizedPath,
			name:
				file instanceof TFile
					? file.basename
					: stripSupportedBookExtension(normalizedPath.split("/").pop() || "") || "书籍",
			folder:
				file instanceof TFile
					? file.parent?.path || "/"
					: slashIndex >= 0
					? normalizedPath.slice(0, slashIndex) || "/"
					: "/",
			size,
			mtime,
		};
	}

	private async scanVaultBookshelfEntries(folderPath?: string): Promise<EpubScanIndexEntry[]> {
		const pathSet = new Set<string>(this.collectEpubPathsFromVaultIndex(folderPath));

		const canonicalPaths = new Set<string>();
		for (const path of pathSet) {
			const canonicalPath = this.resolveSupportedBookFilePath(path);
			if (canonicalPath) {
				canonicalPaths.add(canonicalPath);
			}
		}

		const entries = await Promise.all(
			Array.from(canonicalPaths).map((path) => this.createScanIndexEntryFromPath(path))
		);

		return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	}

	private async hasExistingEpubFile(filePath: string): Promise<boolean> {
		return this.resolveSupportedBookFilePath(filePath) !== null;
	}

	resolveSupportedBookFilePath(filePath: string): string | null {
		return resolveCanonicalSupportedBookFilePath(this.app, filePath);
	}

	async isBookshelfSourceMissing(filePath: string): Promise<boolean> {
		if (this.resolveSupportedBookFilePath(filePath)) {
			return false;
		}
		const normalizedPath = normalizePath(filePath || "");
		if (!normalizedPath || !this.isEpubPath(normalizedPath)) {
			return true;
		}
		const adapter = this.app.vault.adapter as { exists?: (path: string) => Promise<boolean> };
		if (typeof adapter.exists !== "function") {
			return true;
		}
		try {
			return !(await adapter.exists(normalizedPath));
		} catch {
			return true;
		}
	}

	private async readBookState(
		bookId: string
	): Promise<Pick<EpubBook, "currentPosition" | "readingStats"> | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate?.reading) {
			return null;
		}
		return {
			currentPosition: aggregate.reading.position,
			readingStats: aggregate.reading.stats,
		};
	}

	private async writeBookState(
		bookId: string,
		data: Pick<EpubBook, "currentPosition" | "readingStats">
	): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const previous = this._bookStateWriteLocks.get(bookId) || Promise.resolve();
		const persist = async () => {
			const aggregate = await this.getV2Store().getBook(bookId);
			if (!aggregate) {
				return;
			}
			const normalizedStats = normalizeReadingPaceStats(data.readingStats);
			this.getV2Store().saveReading(bookId, {
				position: data.currentPosition,
				lastPosition: aggregate.reading?.lastPosition ?? null,
				stats: normalizedStats,
			});
			const cachedBook = this._booksCache?.[bookId];
			if (cachedBook) {
				cachedBook.currentPosition = data.currentPosition;
				cachedBook.readingStats = normalizedStats;
			}
		};
		const next = previous.then(persist, persist);
		this._bookStateWriteLocks.set(bookId, next);
		await next;
	}

	async hydrateBookState(bookId: string): Promise<void> {
		const books = await this.loadBooks({ hydrateStates: false });
		const normalizedBookId = this.resolveBookIdAlias(await this.resolveCanonicalBookId(bookId));
		const book = books[normalizedBookId];
		if (!book) {
			return;
		}

		const state = await this.readBookState(book.id);
		if (!state) {
			return;
		}

		book.currentPosition = state.currentPosition ?? book.currentPosition;
		book.readingStats = state.readingStats ?? book.readingStats;
	}

	private async hydrateBookStates(books: Record<string, EpubBook>): Promise<void> {
		// v2：书目录本身已携带 reading（position/stats），无需逐书水合。
		void books;
	}

	async saveBooks(books: Record<string, EpubBook>): Promise<void> {
		await this.writeBooksWithLock(books);
	}

	async saveBook(book: EpubBook, options: { ensureOnBookshelf?: boolean } = {}): Promise<void> {
		await this.ensureAutomaticDataMigrations();
		const sourceEntry = await this.ensureSourceIdentity(book.filePath, {
			preferredSourceId: book.sourceId,
			preferredSourceFingerprint: book.sourceFingerprint,
		});
		if (sourceEntry) {
			book.sourceId = sourceEntry.sourceId;
			book.sourceFingerprint = sourceEntry.sourceFingerprint;
			book.sourceSize = sourceEntry.sourceSize;
			book.sourceMtime = sourceEntry.sourceMtime;
			book.filePath = sourceEntry.filePath;
		}

		const books = await this.loadBooks();
		const existingBook =
			(sourceEntry?.sourceId
				? this.findBookInCollectionBySourceId(books, sourceEntry.sourceId)
				: null) ||
			(sourceEntry?.sourceFingerprint
				? this.findBookInCollectionByFingerprint(books, sourceEntry.sourceFingerprint)
				: null) ||
			this.findBookInCollectionByFilePath(books, book.filePath);
		if (existingBook?.id) {
			book.id = existingBook.id;
		} else if (!String(book.id || "").trim() || this.isEphemeralBookId(book.id)) {
			book.id = this.buildStableBookId({
				sourceId: sourceEntry?.sourceId || book.sourceId,
				sourceFingerprint: sourceEntry?.sourceFingerprint || book.sourceFingerprint,
				filePath: book.filePath,
			});
		}
		books[book.id] = book;
		await this.writeBooksWithLock(books);
		await this.upsertScanIndexEntry(book.filePath);
		if (options.ensureOnBookshelf) {
			await this.addBooksToBookshelf([book.filePath]);
		}
	}

	async loadScanIndex(): Promise<EpubScanIndexEntry[]> {
		// v2：书架索引直接由 books 聚合派生（标题/封面取自 aggregate.meta）。
		await this.ensureAutomaticDataMigrations();
		const books = await this.loadBooks({ hydrateStates: false });
		const entries = this.buildBookshelfIndexEntriesFromBooks(books);
		return entries.map((entry) => {
			const book = Object.values(books).find(
				(candidate) => normalizePath(candidate.filePath) === entry.path
			);
			return {
				...entry,
				mtime: 0,
				coverImage: book?.metadata?.coverImage || undefined,
			};
		});
	}

	async loadBookshelfIndex(): Promise<EpubBookshelfIndexEntry[]> {
		const entries = await this.loadScanIndex();
		return entries.map((entry) => this.toBookshelfIndexEntry(entry));
	}

	/** v2：扫描索引不再独立持久化（书架 = books 聚合）。保留为 no-op 兼容调用方。 */
	async saveScanIndex(_entries: EpubScanIndexEntry[]): Promise<void> {
		return;
	}

	/** 封面不再持久化：现读 + 会话内存缓存（见 BookshelfView.covers）。此方法保留为 no-op 兼容调用方。 */
	async cacheBookshelfCoverImage(
		_filePath: string,
		_coverImage: string | null | undefined
	): Promise<void> {
		return;
	}

	async saveBookshelfIndex(_entries: EpubBookshelfIndexEntry[]): Promise<void> {
		return;
	}

	async scanVaultBooks(): Promise<EpubScanIndexEntry[]> {
		// v2：扫描结果仅用于导入弹窗，不再写入扫描索引。
		return this.scanVaultBookshelfEntries();
	}

	async scanVaultEpubs(): Promise<EpubScanIndexEntry[]> {
		return this.scanVaultBooks();
	}

	async rebuildBookshelfIndex(folderPath?: string): Promise<EpubBookshelfIndexEntry[]> {
		const normalizedFolder = this.normalizeScanFolderScope(folderPath);
		const entries = await this.scanVaultBookshelfEntries(normalizedFolder);
		return entries.map((entry) => this.toBookshelfIndexEntry(entry));
	}

	async loadBookshelfEntriesForFolder(folderPath: string): Promise<EpubBookshelfIndexEntry[]> {
		const normalizedFolder = this.normalizeScanFolderScope(folderPath);
		if (!normalizedFolder) {
			return [];
		}
		const entries = await this.scanVaultBookshelfEntries(normalizedFolder);
		return entries.map((entry) => this.toBookshelfIndexEntry(entry));
	}

	/** v2：不再需要（扫描索引不持久化）。 */
	private async upsertScanIndexEntry(_filePath: string): Promise<void> {
		return;
	}

	/** v2：不再需要（扫描索引不持久化）。 */
	private async removeScanIndexEntry(_filePath: string): Promise<boolean> {
		return false;
	}

	async getBook(bookId: string): Promise<EpubBook | null> {
		const books = await this.loadBooks({ hydrateStates: false });
		const normalizedBookId = this.resolveBookIdAlias(bookId);
		return books[normalizedBookId] || null;
	}

	/** v2：书架成员 = books 聚合（无独立 membership 存储）。 */
	async loadBookshelfMembership(): Promise<EpubBookshelfMembershipEntry[]> {
		await this.ensureAutomaticDataMigrations();
		const aggregates = await this.getV2Store().getBooks();
		return aggregates
			.map((aggregate) => ({
				path: normalizePath(aggregate.file?.vaultPath ?? ""),
				addedAt: aggregate.audit?.createdAt ?? 0,
				customCoverPath: this.readAggregateUiString(aggregate, "customCoverPath"),
			}))
			.filter((entry) => Boolean(entry.path));
	}

	/** v2：membership 收敛于 books 聚合，保存为 no-op。 */
	async saveBookshelfMembership(_entries: EpubBookshelfMembershipEntry[]): Promise<void> {
		return;
	}

	/** 读取聚合每书 UI 记忆（aggregate.ui）中的字符串字段。 */
	private readAggregateUiString(
		aggregate: { ui?: Record<string, unknown> | null },
		key: string
	): string | undefined {
		const value = aggregate.ui?.[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}

	async loadBookshelfPlaylists(): Promise<EpubBookshelfPlaylist[]> {
		await this.ensureAutomaticDataMigrations();
		const document = await this.getV2Store().getDocument();
		const playlists = document.playlists ?? [];
		const books = await this.loadBooks({ hydrateStates: false });
		const idToPath = new Map<string, string>();
		for (const book of Object.values(books)) {
			idToPath.set(book.id, normalizePath(book.filePath || ""));
		}
		return playlists
			.filter((playlist) => playlist.id && playlist.name)
			.map((playlist) => ({
				id: playlist.id,
				name: playlist.name,
				bookPaths: (playlist.bookIds || [])
					.map((bookId) => idToPath.get(bookId) || "")
					.filter(Boolean),
				createdAt: 0,
				updatedAt: 0,
			}))
			.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	}

	async saveBookshelfPlaylists(playlists: EpubBookshelfPlaylist[]): Promise<void> {
		const books = await this.loadBooks({ hydrateStates: false });
		const pathToId = new Map<string, string>();
		for (const book of Object.values(books)) {
			pathToId.set(normalizePath(book.filePath || ""), book.id);
		}
		const nextPlaylists = playlists
			.filter((playlist) => playlist.id && playlist.name)
			.map((playlist) => ({
				id: playlist.id,
				name: playlist.name,
				bookIds: (playlist.bookPaths || [])
					.map((path) => pathToId.get(normalizePath(path)) || "")
					.filter(Boolean),
			}));
		this.getV2Store().saveSettings({ playlists: nextPlaylists });
	}

	async createBookshelfPlaylist(name: string, bookPaths: string[] = []): Promise<EpubBookshelfPlaylist> {
		const trimmedName = String(name || "").trim();
		if (!trimmedName) {
			throw new Error("Playlist name is required");
		}
		const playlist: EpubBookshelfPlaylist = {
			id: createBookshelfPlaylistId(),
			name: trimmedName,
			bookPaths: normalizeBookshelfPlaylistBookPaths(bookPaths),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const playlists = await this.loadBookshelfPlaylists();
		playlists.push(playlist);
		await this.saveBookshelfPlaylists(playlists);
		return playlist;
	}

	async renameBookshelfPlaylist(playlistId: string, name: string): Promise<EpubBookshelfPlaylist | null> {
		const trimmedName = String(name || "").trim();
		if (!trimmedName) {
			return null;
		}
		const playlists = await this.loadBookshelfPlaylists();
		const index = playlists.findIndex((playlist) => playlist.id === playlistId);
		if (index < 0) {
			return null;
		}
		const nextPlaylist = {
			...playlists[index],
			name: trimmedName,
			updatedAt: Date.now(),
		};
		playlists[index] = nextPlaylist;
		await this.saveBookshelfPlaylists(playlists);
		return nextPlaylist;
	}

	async addBookToBookshelfPlaylist(playlistId: string, bookPath: string): Promise<EpubBookshelfPlaylist | null> {
		const normalizedPath = normalizePath(String(bookPath || "").trim());
		if (!normalizedPath) {
			return null;
		}
		if (!(await this.checkBookshelfMembership(normalizedPath))) {
			return null;
		}
		const playlists = await this.loadBookshelfPlaylists();
		const index = playlists.findIndex((playlist) => playlist.id === playlistId);
		if (index < 0) {
			return null;
		}
		const playlist = playlists[index];
		if (playlist.bookPaths.includes(normalizedPath)) {
			return playlist;
		}
		const nextPlaylist: EpubBookshelfPlaylist = {
			...playlist,
			bookPaths: [...playlist.bookPaths, normalizedPath],
			updatedAt: Date.now(),
		};
		playlists[index] = nextPlaylist;
		await this.saveBookshelfPlaylists(playlists);
		return nextPlaylist;
	}

	async removeBookFromBookshelfPlaylist(
		playlistId: string,
		bookPath: string
	): Promise<EpubBookshelfPlaylist | null> {
		const normalizedPath = normalizePath(String(bookPath || "").trim());
		const playlists = await this.loadBookshelfPlaylists();
		const index = playlists.findIndex((playlist) => playlist.id === playlistId);
		if (index < 0) {
			return null;
		}
		const playlist = playlists[index];
		const nextPaths = playlist.bookPaths.filter((path) => path !== normalizedPath);
		if (nextPaths.length === playlist.bookPaths.length) {
			return playlist;
		}
		const nextPlaylist: EpubBookshelfPlaylist = {
			...playlist,
			bookPaths: nextPaths,
			updatedAt: Date.now(),
		};
		playlists[index] = nextPlaylist;
		await this.saveBookshelfPlaylists(playlists);
		return nextPlaylist;
	}

	async deleteBookshelfPlaylist(playlistId: string): Promise<boolean> {
		const playlists = await this.loadBookshelfPlaylists();
		const nextPlaylists = playlists.filter((playlist) => playlist.id !== playlistId);
		if (nextPlaylists.length === playlists.length) {
			return false;
		}
		await this.saveBookshelfPlaylists(nextPlaylists);
		return true;
	}

	/** v2：source 注册表由 books 聚合派生（file.sourceId/sourceFingerprint）。 */
	async loadSourceRegistry(): Promise<EpubSourceRegistryEntry[]> {
		const books = await this.loadBooks({ hydrateStates: false });
		const entries: EpubSourceRegistryEntry[] = [];
		for (const book of Object.values(books)) {
			const sourceId = String(book.sourceId || "").trim();
			if (!sourceId && !book.sourceFingerprint) {
				continue;
			}
			entries.push({
				sourceId: sourceId || this.generateSourceId(book.sourceFingerprint),
				filePath: normalizePath(book.filePath || ""),
				sourceFingerprint: book.sourceFingerprint,
				lastSeenAt: book.readingStats?.lastReadTime || 0,
				lastKnownPath: normalizePath(book.filePath || ""),
			});
		}
		return entries;
	}

	/** v2：注册表不再独立持久化，保留为 no-op 兼容调用方。 */
	async saveSourceRegistry(_entries: EpubSourceRegistryEntry[]): Promise<void> {
		return;
	}

	private generateSourceId(sourceFingerprint?: string): string {
		const normalizedFingerprint = String(sourceFingerprint || "").trim().toLowerCase();
		if (normalizedFingerprint) {
			return `epubsrc-${normalizedFingerprint.slice(0, 24)}`;
		}
		return `epubsrc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	}

	private buildStableBookId(input: {
		sourceId?: string;
		sourceFingerprint?: string;
		filePath?: string;
	}): string {
		const seed =
			String(input.sourceId || "").trim() ||
			String(input.sourceFingerprint || "").trim() ||
			normalizePath(String(input.filePath || "").trim()) ||
			"epub-book";
		return `epub-book-${this.hashString(seed)}`;
	}

	private isEphemeralBookId(bookId?: string): boolean {
		const normalizedBookId = String(bookId || "").trim();
		return /^epub-[0-9a-z]+$/i.test(normalizedBookId);
	}

	private hashString(input: string): string {
		let hash = 2166136261;
		for (let index = 0; index < input.length; index += 1) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(36);
	}

	private async computeSourceFingerprint(filePath: string): Promise<string | undefined> {
		const normalizedPath = normalizePath(filePath || "");
		if (!normalizedPath) {
			return undefined;
		}

		const adapter = this.app.vault.adapter as {
			readBinary?: (path: string) => Promise<ArrayBuffer | Uint8Array>;
		};
		if (typeof adapter.readBinary !== "function" || typeof crypto?.subtle?.digest !== "function") {
			return undefined;
		}

		try {
			const binary = await adapter.readBinary(normalizedPath);
			const input = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
			const digest = await crypto.subtle.digest("SHA-256", input);
			return Array.from(new Uint8Array(digest))
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("");
		} catch (error) {
			logger.debug("[EpubStorageService] Failed to compute book source fingerprint:", {
				filePath: normalizedPath,
				error,
			});
			return undefined;
		}
	}

	async ensureSourceIdentity(
		filePath: string,
		options: { preferredSourceId?: string; preferredSourceFingerprint?: string } = {}
	): Promise<EpubSourceRegistryEntry | null> {
		const normalizedPath = normalizePath(filePath || "");
		if (!normalizedPath || !(await this.hasExistingEpubFile(normalizedPath))) {
			return null;
		}

		// v2：source 身份收敛于 books 聚合（无独立注册表）。
		const books = await this.loadBooks({ hydrateStates: false });
		const preferredSourceFingerprint = String(
			options.preferredSourceFingerprint || ""
		).trim().toLowerCase();
		const sourceFingerprint =
			preferredSourceFingerprint || (await this.computeSourceFingerprint(normalizedPath));
		const canonicalSourceId = sourceFingerprint
			? this.generateSourceId(sourceFingerprint)
			: undefined;

		const byPath = this.findBookInCollectionByFilePath(books, normalizedPath);
		const byFingerprint = sourceFingerprint
			? this.findBookInCollectionByFingerprint(books, sourceFingerprint)
			: undefined;
		const preferredSourceId = String(options.preferredSourceId || "").trim();
		const byPreferredId = preferredSourceId
			? this.findBookInCollectionBySourceId(books, preferredSourceId)
			: undefined;
		const target = byPath || byFingerprint || byPreferredId;

		if (target?.id) {
			const targetSourceId = String(target.sourceId || "").trim();
			return {
				sourceId: targetSourceId || canonicalSourceId || this.generateSourceId(),
				filePath: normalizePath(target.filePath || ""),
				sourceFingerprint: target.sourceFingerprint,
				lastSeenAt: target.readingStats?.lastReadTime || 0,
				lastKnownPath: normalizePath(target.filePath || ""),
			};
		}

		// 无既有身份：返回新身份，由调用方（saveBook 等）写入 books 聚合。
		return {
			sourceId: canonicalSourceId || preferredSourceId || this.generateSourceId(),
			filePath: normalizedPath,
			sourceFingerprint,
			lastSeenAt: Date.now(),
			lastKnownPath: normalizedPath,
		};
	}

	async resolveSourceFilePath(
		sourceId?: string,
		fallbackFilePath?: string
	): Promise<string | null> {
		const normalizedFallback = normalizePath(fallbackFilePath || "");
		if (sourceId) {
			const books = await this.loadBooks({ hydrateStates: false });
			const book = this.findBookInCollectionBySourceId(books, sourceId);
			if (book?.filePath && (await this.hasExistingEpubFile(book.filePath))) {
				return normalizePath(book.filePath);
			}

			if (normalizedFallback && (await this.hasExistingEpubFile(normalizedFallback))) {
				await this.ensureSourceIdentity(normalizedFallback, { preferredSourceId: sourceId });
				return normalizedFallback;
			}
		}

		if (normalizedFallback && (await this.hasExistingEpubFile(normalizedFallback))) {
			return normalizedFallback;
		}

		return null;
	}

	async listBookshelfEntries(
		options?: { pruneMissing?: boolean }
	): Promise<EpubBookshelfIndexEntry[]> {
		if (options?.pruneMissing) {
			await this.pruneMissingBooks();
		}

		// v2：书架条目直接由 books 聚合派生。
		const books = await this.loadBooks({ hydrateStates: false });
		const entries: EpubBookshelfIndexEntry[] = [];
		for (const book of Object.values(books)) {
			const path = normalizePath(book.filePath || "");
			if (!path) {
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			const slashIndex = path.lastIndexOf("/");
			const aggregate = await this.getV2Store().getBook(book.id);
			entries.push({
				path,
				name:
					stripSupportedBookExtension(path.split("/").pop() || "") ||
					book.metadata.title ||
					"书籍",
				folder: slashIndex >= 0 ? path.slice(0, slashIndex) || "/" : "/",
				size: file instanceof TFile ? file.stat.size : 0,
				addedAt:
					aggregate?.audit?.createdAt ??
					(typeof book.readingStats?.createdTime === "number"
						? book.readingStats.createdTime
						: 0),
				customCoverPath: aggregate ? this.readAggregateUiString(aggregate, "customCoverPath") : undefined,
			});
		}

		return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	}

	async addBooksToBookshelf(paths: string[]): Promise<EpubBookshelfMembershipEntry[]> {
		const normalizedPaths = Array.from(
			new Set(paths.map((path) => normalizePath(path || "")).filter(Boolean))
		);
		if (normalizedPaths.length === 0) {
			return [];
		}

		const books = await this.loadBooks({ hydrateStates: false });
		const addedEntries: EpubBookshelfMembershipEntry[] = [];
		const now = Date.now();

		for (let index = 0; index < normalizedPaths.length; index += 1) {
			const requestedPath = normalizedPaths[index];
			const canonicalPath = this.resolveSupportedBookFilePath(requestedPath);
			if (!canonicalPath || this.findBookInCollectionByFilePath(books, canonicalPath)?.id) {
				continue;
			}

			const scanEntry = await this.createScanIndexEntryFromPath(canonicalPath);
			const shelfBook = this.buildShelfOnlyBookFromScanEntry(
				scanEntry ?? {
					path: canonicalPath,
					name:
						stripSupportedBookExtension(canonicalPath.split("/").pop() || "") ||
						"书籍",
					folder:
						canonicalPath.lastIndexOf("/") >= 0
							? canonicalPath.slice(0, canonicalPath.lastIndexOf("/")) || "/"
							: "/",
					size: 0,
					mtime: 0,
				}
			);
			const sourceIdentity = await this.ensureSourceIdentity(canonicalPath);
			if (sourceIdentity?.sourceId) {
				shelfBook.sourceId = sourceIdentity.sourceId;
				shelfBook.sourceFingerprint = sourceIdentity.sourceFingerprint;
			}
			books[shelfBook.id] = shelfBook;
			addedEntries.push({
				path: canonicalPath,
				addedAt: now + index,
			});
		}

		if (addedEntries.length > 0) {
			await this.writeBooksWithLock(books);
		}

		return addedEntries;
	}

	async checkBookshelfMembership(filePath: string): Promise<boolean> {
		const books = await this.loadBooks({ hydrateStates: false });
		return Boolean(this.findBookInCollectionByFilePath(books, filePath));
	}

	async ensureBookOnBookshelf(filePath: string): Promise<void> {
		await this.addBooksToBookshelf([filePath]);
	}

	async findBookByFilePath(filePath: string): Promise<EpubBook | null> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return null;
		}

		const books = await this.loadBooks({ hydrateStates: false });
		const catalogBook = this.findBookInCollectionByFilePath(books, normalizedFilePath);
		if (catalogBook?.id) {
			await this.hydrateBookState(catalogBook.id);
			return (await this.getBook(catalogBook.id)) ?? catalogBook;
		}

		const membership = await this.loadBookshelfMembership();
		const isMember = membership.some(
			(entry) => normalizePath(entry.path || "") === normalizedFilePath
		);
		if (!isMember) {
			return null;
		}

		const scanEntries = await this.loadScanIndex();
		const scanEntry =
			scanEntries.find((entry) => normalizePath(entry.path) === normalizedFilePath) ??
			(await this.createScanIndexEntryFromPath(normalizedFilePath));
		const book = this.buildShelfOnlyBookFromScanEntry(scanEntry);
		if (!this._booksCache) {
			this._booksCache = { [book.id]: book };
		} else {
			this._booksCache[book.id] = book;
		}
		return book;
	}

	async updateBookDisplayTitle(book: EpubBook): Promise<EpubBook> {
		await this.ensureAutomaticDataMigrations();
		const nextTitle = String(book.metadata?.title || "").trim();
		if (!nextTitle) {
			throw new Error("Book title is required");
		}

		const normalizedMetadata = this.normalizeBookMetadata({
			...book.metadata,
			title: nextTitle,
		});
		if (!normalizedMetadata) {
			throw new Error("Book metadata is invalid");
		}

		const nextBook: EpubBook = {
			...book,
			metadata: normalizedMetadata,
		};

		const paragraphPosition = await this.loadParagraphModeReadingPosition(nextBook.id);
		if (paragraphPosition) {
			await this.saveParagraphModeReadingPosition({
				...paragraphPosition,
				bookTitle: nextTitle,
			});
		}

		await this.saveBook(nextBook, { ensureOnBookshelf: true });
		return nextBook;
	}

	async findBookBySourceId(sourceId: string): Promise<EpubBook | null> {
		const normalizedSourceId = String(sourceId || "").trim();
		if (!normalizedSourceId) {
			return null;
		}

		return this.findBookInCollectionBySourceId(
			await this.loadBooks({ hydrateStates: false }),
			normalizedSourceId
		);
	}

	private findBookInCollectionByFilePath(
		books: Record<string, EpubBook>,
		filePath: string
	): EpubBook | null {
		const normalizedFilePath = normalizePath(filePath || "");
		for (const book of Object.values(books)) {
			if (normalizePath(book.filePath || "") === normalizedFilePath) {
				return book;
			}
		}
		return null;
	}

	private findBookInCollectionBySourceId(
		books: Record<string, EpubBook>,
		sourceId: string
	): EpubBook | null {
		const normalizedSourceId = String(sourceId || "").trim();
		for (const book of Object.values(books)) {
			if (String(book.sourceId || "").trim() === normalizedSourceId) {
				return book;
			}
		}
		return null;
	}

	private findBookInCollectionByFingerprint(
		books: Record<string, EpubBook>,
		sourceFingerprint: string
	): EpubBook | null {
		const normalizedFingerprint = String(sourceFingerprint || "").trim().toLowerCase();
		if (!normalizedFingerprint) {
			return null;
		}
		for (const book of Object.values(books)) {
			if (String(book.sourceFingerprint || "").trim().toLowerCase() === normalizedFingerprint) {
				return book;
			}
		}
		return null;
	}

	async updateBookFileReferences(oldPath: string, newPath: string): Promise<number> {
		const normalizedOldPath = normalizePath(oldPath || "");
		const normalizedNewPath = normalizePath(newPath || "");
		if (!normalizedOldPath || !normalizedNewPath || normalizedOldPath === normalizedNewPath) {
			return 0;
		}

		const books = await this.loadBooks();
		let updated = 0;
		let changed = false;

		for (const book of Object.values(books)) {
			const remapped = this.remapPath(book.filePath, normalizedOldPath, normalizedNewPath);
			if (!remapped || remapped === book.filePath) {
				continue;
			}

			const aggregate = await this.getV2Store().getBook(book.id);
			const legacyPaths = Array.from(
				new Set([
					...(aggregate?.file?.legacyPaths ?? []),
					normalizePath(book.filePath || ""),
				].filter(Boolean))
			);
			book.filePath = remapped;
			this.getV2Store().upsertBook(
				toEpubBookAggregate(book, {
					notes: aggregate?.notes,
					lastPosition: aggregate?.reading?.lastPosition,
					ui: aggregate?.ui,
					legacyPaths,
				})
			);
			updated += 1;
			changed = true;
		}

		return updated;
	}

	private async removeBookPathFromAllPlaylists(bookPath: string): Promise<boolean> {
		const normalizedPath = normalizePath(bookPath || "");
		if (!normalizedPath) {
			return false;
		}

		const books = await this.loadBooks({ hydrateStates: false });
		const book = this.findBookInCollectionByFilePath(books, normalizedPath);
		if (!book?.id) {
			return false;
		}

		const playlists = await this.loadBookshelfPlaylists();
		let changed = false;
		const nextPlaylists = playlists.map((playlist) => {
			const bookPaths = playlist.bookPaths.filter((path) => path !== normalizedPath);
			if (bookPaths.length === playlist.bookPaths.length) {
				return playlist;
			}
			changed = true;
			return {
				...playlist,
				bookPaths,
				updatedAt: Date.now(),
			};
		});

		if (changed) {
			await this.saveBookshelfPlaylists(nextPlaylists);
		}
		return true;
	}

	private async removeBookIdFromAllPlaylists(bookId: string): Promise<void> {
		const normalizedBookId = String(bookId || "").trim();
		if (!normalizedBookId) {
			return;
		}

		const document = await this.getV2Store().getDocument();
		const playlists = document.playlists ?? [];
		let changed = false;
		const nextPlaylists = playlists
			.map((playlist) => {
				const bookIds = (playlist.bookIds || []).filter((id) => id !== normalizedBookId);
				if (bookIds.length === (playlist.bookIds || []).length) {
					return playlist;
				}
				changed = true;
				return { ...playlist, bookIds };
			})
			.filter((playlist) => playlist.bookIds.length > 0);

		if (changed) {
			this.getV2Store().saveSettings({ playlists: nextPlaylists });
		}
	}

	async remapBookshelfMembershipPaths(oldPath: string, newPath: string): Promise<number> {
		// v2：membership/playlists 均派生自 books 聚合，改名只需更新聚合路径。
		return this.updateBookFileReferences(oldPath, newPath);
	}

	async setBookshelfCustomCover(filePath: string, coverPath: string | null): Promise<boolean> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return false;
		}

		const books = await this.loadBooks({ hydrateStates: false });
		const book = this.findBookInCollectionByFilePath(books, normalizedFilePath);
		if (!book?.id) {
			return false;
		}

		const aggregate = await this.getV2Store().getBook(book.id);
		if (!aggregate) {
			return false;
		}
		const normalizedCoverPath = coverPath ? normalizePath(coverPath) : "";
		this.getV2Store().upsertBook({
			...aggregate,
			ui: {
				...(aggregate.ui ?? {}),
				customCoverPath: normalizedCoverPath || undefined,
			},
		});
		return true;
	}

	async pruneMissingBooks(): Promise<{ removedBookIds: string[]; removedPaths: string[] }> {
		const books = await this.loadBooks({ hydrateStates: false });
		const removedBookIds: string[] = [];
		const removedPaths: string[] = [];

		const existenceChecks = await Promise.all(
			Object.entries(books).map(async ([bookId, book]) => ({
				bookId,
				book,
				exists: await this.hasExistingEpubFile(book.filePath),
			}))
		);

		for (const { bookId, book, exists } of existenceChecks) {
			if (exists) {
				continue;
			}
			removedBookIds.push(bookId);
			removedPaths.push(book.filePath);
			this.getV2Store().removeBook(bookId);
			await this.removeBookIdFromAllPlaylists(bookId);
		}

		if (removedBookIds.length > 0 && this._booksCache) {
			for (const bookId of removedBookIds) {
				delete this._booksCache[bookId];
			}
		}

		logger.info("[EpubStorageService] Pruned missing EPUB records:", {
			removedBookIds,
			removedPaths,
		});

		return { removedBookIds, removedPaths };
	}

	private async deleteBook(bookId: string): Promise<void> {
		this.getV2Store().removeBook(bookId);
		if (this._booksCache) {
			delete this._booksCache[bookId];
		}
		await this.removeBookIdFromAllPlaylists(bookId);
	}

	async removeFromBookshelfByFilePath(
		filePath: string,
		options: { purgeCache?: boolean } = {}
	): Promise<{ removedBookId: string | null; removedMembership: boolean }> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return { removedBookId: null, removedMembership: false };
		}

		// v2：书架成员即 books 聚合，移除书架 = 删除聚合（阅读记录一并清除）。
		const existingBook = await this.findBookByFilePath(normalizedFilePath);
		if (!existingBook?.id) {
			return { removedBookId: null, removedMembership: false };
		}

		await this.deleteBook(existingBook.id);
		await this.removeBookPathFromAllPlaylists(normalizedFilePath);
		return {
			removedBookId: existingBook.id,
			removedMembership: true,
		};
	}

	async removeMissingBookshelfEntry(filePath: string): Promise<void> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return;
		}

		if (!(await this.isBookshelfSourceMissing(normalizedFilePath))) {
			const canonicalPath = this.resolveSupportedBookFilePath(normalizedFilePath);
			if (canonicalPath && canonicalPath !== normalizedFilePath) {
				await this.updateBookFileReferences(normalizedFilePath, canonicalPath);
			}
			return;
		}

		await this.removeFromBookshelfByFilePath(normalizedFilePath, { purgeCache: true });
		await this.pruneMissingBooks();
	}

	async removeBookshelfEntryForDeletedVaultFile(filePath: string): Promise<void> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return;
		}

		await this.removeFromBookshelfByFilePath(normalizedFilePath, { purgeCache: true });
	}

	async removeBookFromBookshelf(
		filePath: string,
		options: { purgeCache?: boolean } = {}
	): Promise<{ removedBookId: string | null; removedMembership: boolean }> {
		return this.removeFromBookshelfByFilePath(filePath, options);
	}

	async removeBookByFilePath(
		filePath: string
	): Promise<{ removedBookId: string | null; removedIndexEntry: boolean }> {
		const result = await this.removeFromBookshelfByFilePath(filePath, { purgeCache: true });
		return {
			removedBookId: result.removedBookId,
			removedIndexEntry: result.removedMembership,
		};
	}

	async deleteTrackedBookFile(filePath: string): Promise<EpubDeleteTrackedBookResult> {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return {
				deletedFilePath: null,
				fileDeleted: false,
				removedScanEntries: 0,
				removedMembershipEntries: 0,
				removedBookIds: [],
			};
		}

		let fileDeleted = false;
		const abstractFile = this.app.vault.getAbstractFileByPath(normalizedFilePath);
		if (abstractFile instanceof TFile) {
			const trashFile = (this.app as App & {
				fileManager?: {
					trashFile?: (file: TFile) => Promise<void>;
				};
			}).fileManager?.trashFile;
			if (typeof trashFile === "function") {
				await trashFile.call((this.app as App & { fileManager?: unknown }).fileManager, abstractFile);
			} else {
				await this.app.vault.adapter.remove(normalizedFilePath);
			}
			fileDeleted = true;
		} else if (await this.app.vault.adapter.exists(normalizedFilePath)) {
			await this.app.vault.adapter.remove(normalizedFilePath);
			fileDeleted = true;
		}

		const cleanup = await this.removeTrackedEpubTarget(normalizedFilePath);
		return {
			deletedFilePath: fileDeleted ? normalizedFilePath : null,
			fileDeleted,
			removedScanEntries: cleanup.removedScanEntries,
			removedMembershipEntries: cleanup.removedMembershipEntries,
			removedBookIds: cleanup.removedBookIds,
		};
	}

	async removeTrackedEpubTarget(targetPath: string): Promise<{
		removedScanEntries: number;
		removedMembershipEntries: number;
		removedBookIds: string[];
	}> {
		const normalizedTargetPath = normalizePath(targetPath || "");
		if (!normalizedTargetPath) {
			return {
				removedScanEntries: 0,
				removedMembershipEntries: 0,
				removedBookIds: [],
			};
		}

		const matchesTarget = (path: string) =>
			path === normalizedTargetPath || path.startsWith(`${normalizedTargetPath}/`);

		const books = await this.loadBooks();
		const removedBookIds: string[] = [];
		const removedBookPaths: string[] = [];
		for (const [bookId, book] of Object.entries(books)) {
			if (!matchesTarget(normalizePath(book.filePath || ""))) {
				continue;
			}
			removedBookIds.push(bookId);
			removedBookPaths.push(normalizePath(book.filePath || ""));
			this.getV2Store().removeBook(bookId);
			if (this._booksCache) {
				delete this._booksCache[bookId];
			}
			await this.removeBookIdFromAllPlaylists(bookId);
		}
		if (removedBookIds.length > 0) {
			for (const bookPath of removedBookPaths) {
				await this.removeBookPathFromAllPlaylists(bookPath);
			}
		}

		const scanEntries = await this.loadScanIndex();
		const removedScanEntries = scanEntries.filter((entry) => matchesTarget(entry.path)).length;
		void removedScanEntries;

		const membership = await this.loadBookshelfMembership();
		const removedMembershipEntries = membership.filter((entry) =>
			matchesTarget(entry.path)
		).length;
		void removedMembershipEntries;

		return {
			removedScanEntries,
			removedMembershipEntries,
			removedBookIds,
		};
	}

	/** v2：读取某书的高亮记录（books[id].notes.highlights）。 */
	async loadBookHighlights(bookId: string): Promise<EpubStoredHighlight[]> {
		const aggregate = await this.getV2Store().getBook(
			await this.resolveCanonicalBookId(bookId)
		);
		return aggregate?.notes?.highlights ?? [];
	}

	/** v2：整组覆盖某书的高亮记录（书不存在时忽略）。 */
	async saveBookHighlights(bookId: string, highlights: EpubStoredHighlight[]): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate) {
			return;
		}
		this.getV2Store().saveBookNotes(bookId, {
			...aggregate.notes,
			highlights,
		});
	}

	async saveProgress(
		bookId: string,
		position: ReadingPosition,
		readingStats?: ReadingStats
	): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		this._pendingProgress = { bookId, position, readingStats };
		if (this._progressDebounceTimer) return;
		this._progressDebounceTimer = window.setTimeout(() => {
			void (async () => {
				this._progressDebounceTimer = null;
				const pending = this._pendingProgress;
				if (!pending) return;
				this._pendingProgress = null;
				try {
					const book = await this.getBook(pending.bookId);
					if (book) {
						book.currentPosition = pending.position;
						if (pending.readingStats) {
							book.readingStats = normalizeReadingPaceStats(pending.readingStats);
						}
						book.readingStats.lastReadTime = Date.now();
						await this.writeBookState(book.id, {
							currentPosition: book.currentPosition,
							readingStats: book.readingStats,
						});
					}
				} catch (e) {
					logger.warn("[EpubStorageService] saveProgress failed:", e);
				}
			})();
		}, 300);
	}

	async flushPendingProgress(): Promise<void> {
		if (this._progressDebounceTimer) {
			window.clearTimeout(this._progressDebounceTimer);
			this._progressDebounceTimer = null;
		}
		const pending = this._pendingProgress;
		if (pending) {
			this._pendingProgress = null;
			try {
				const canonicalBookId = await this.resolveCanonicalBookId(pending.bookId);
				const book = await this.getBook(canonicalBookId);
				if (book) {
					book.currentPosition = pending.position;
					if (pending.readingStats) {
						book.readingStats = normalizeReadingPaceStats(pending.readingStats);
					}
					book.readingStats.lastReadTime = Date.now();
					await this.writeBookState(book.id, {
						currentPosition: book.currentPosition,
						readingStats: book.readingStats,
					});
				}
			} catch (error) {
				logger.warn("[EpubStorageService] flushPendingProgress failed:", error);
			}
		}
	}

	async loadProgress(bookId: string, bookHint?: EpubBook): Promise<ReadingPosition | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const existingBook = (await this.getBook(bookId)) ?? bookHint ?? null;
		if (existingBook?.currentPosition?.cfi) {
			return existingBook.currentPosition;
		}

		await this.hydrateBookState(bookId);
		const hydratedBook = await this.getBook(bookId);
		if (hydratedBook?.currentPosition?.cfi) {
			return hydratedBook.currentPosition;
		}

		return null;
	}

	async markBookCompleted(bookId: string, completedAt = Date.now()): Promise<EpubBook | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const book = await this.getBook(bookId);
		if (!book) {
			return null;
		}
		const timestamp = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : Date.now();
		book.readingStats = normalizeReadingPaceStats({
			...book.readingStats,
			completedTime: book.readingStats.completedTime ?? timestamp,
		});
		await this.writeBookState(book.id, {
			currentPosition: book.currentPosition,
			readingStats: book.readingStats,
		});
		return book;
	}

	async clearBookCompletion(bookId: string): Promise<EpubBook | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const book = await this.getBook(bookId);
		if (!book) {
			return null;
		}
		const stats = normalizeReadingPaceStats(book.readingStats);
		if (stats.completedTime === undefined) {
			return book;
		}
		const rest = { ...stats };
		delete rest.completedTime;
		book.readingStats = normalizeReadingPaceStats(rest);
		await this.writeBookState(book.id, {
			currentPosition: book.currentPosition,
			readingStats: book.readingStats,
		});
		return book;
	}

	async loadLastOpenBookmark(bookId: string): Promise<EpubLastOpenBookmark | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		await this.hydrateBookState(bookId);
		const aggregate = await this.getV2Store().getBook(bookId);
		const lastPosition = aggregate?.reading?.lastPosition;
		return lastPosition?.cfi ? lastPosition : null;
	}

	async saveLastOpenBookmark(bookId: string, bookmark: EpubLastOpenBookmark): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const normalized = this.normalizeLastOpenBookmark(bookmark);
		if (!normalized?.cfi) {
			return;
		}

		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate) {
			return;
		}
		const stats = normalizeReadingPaceStats({
			...(aggregate.reading?.stats ?? {
				totalReadTime: 0,
				lastReadTime: 0,
				createdTime: 0,
			}),
			lastReadTime: normalized.savedAt,
		});
		const position: ReadingPosition = {
			chapterIndex: normalized.chapterIndex,
			cfi: normalized.cfi,
			percent: normalized.percent,
		};
		this.getV2Store().saveReading(bookId, {
			position,
			lastPosition: normalized,
			stats,
		});
		const cachedBook = this._booksCache?.[bookId];
		if (cachedBook) {
			cachedBook.currentPosition = position;
			cachedBook.readingStats = stats;
		}
	}

	async loadReadingReferencePoint(bookId: string): Promise<EpubReadingReferencePoint | null> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const aggregate = await this.getV2Store().getBook(bookId);
		const lastPosition = aggregate?.reading?.lastPosition;
		if (!lastPosition?.cfi) {
			return null;
		}
		return {
			chapterIndex: lastPosition.chapterIndex,
			cfi: lastPosition.cfi,
			percent: lastPosition.percent,
			title: lastPosition.title,
			savedAt: lastPosition.savedAt,
		};
	}

	async saveReadingReferencePoint(bookId: string, point: EpubReadingReferencePoint): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const normalized = this.normalizeReadingReferencePoint(point);
		if (!normalized?.cfi) {
			return;
		}

		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate) {
			return;
		}
		this.getV2Store().saveReading(bookId, {
			position: aggregate.reading?.position ?? { chapterIndex: 0, cfi: "", percent: 0 },
			lastPosition: {
				chapterIndex: normalized.chapterIndex,
				cfi: normalized.cfi,
				percent: normalized.percent,
				title: normalized.title,
				preview: normalized.title,
				savedAt: normalized.savedAt,
			},
			stats: aggregate.reading?.stats ?? {
				totalReadTime: 0,
				lastReadTime: 0,
				createdTime: 0,
			},
		});
	}

	/** v2：段落位置存 books[id].ui.paragraphModePosition（每书 UI 记忆）。 */
	async loadParagraphModeReadingPosition(bookId: string): Promise<EpubParagraphModeReadingPosition | null> {
		const normalizedBookId = String(bookId || "").trim();
		if (!normalizedBookId) {
			return null;
		}
		const aggregate = await this.getV2Store().getBook(normalizedBookId);
		const position = aggregate?.ui?.paragraphModePosition;
		return position && typeof position === "object"
			? (position as EpubParagraphModeReadingPosition)
			: null;
	}

	/** v2：段落位置存 books[id].ui.paragraphModePosition（每书 UI 记忆）。 */
	async saveParagraphModeReadingPosition(position: EpubParagraphModeReadingPosition): Promise<void> {
		const normalizedBookId = String(position.bookId || "").trim();
		const normalizedCfi = String(position.cfi || "").trim();
		const normalizedParagraphId = String(position.paragraphId || "").trim();
		if (!normalizedBookId || !normalizedCfi || !normalizedParagraphId) {
			return;
		}
		const aggregate = await this.getV2Store().getBook(normalizedBookId);
		if (!aggregate) {
			return;
		}
		this.getV2Store().upsertBook({
			...aggregate,
			ui: {
				...(aggregate.ui ?? {}),
				paragraphModePosition: {
					...position,
					bookId: normalizedBookId,
					cfi: normalizedCfi,
					paragraphId: normalizedParagraphId,
					savedAt: Number.isFinite(position.savedAt) ? position.savedAt : Date.now(),
				},
			},
		});
	}

	async deleteReadingReferencePoint(bookId: string): Promise<void> {
		bookId = await this.resolveCanonicalBookId(bookId);
		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate) {
			return;
		}
		this.getV2Store().saveReading(bookId, {
			position: aggregate.reading?.position ?? { chapterIndex: 0, cfi: "", percent: 0 },
			lastPosition: null,
			stats: aggregate.reading?.stats ?? {
				totalReadTime: 0,
				lastReadTime: 0,
				createdTime: 0,
			},
		});
	}

	async loadPluginUiMemory(): Promise<EpubPluginUiMemory> {
		const document = await this.getV2Store().getDocument();
		return normalizePluginUiMemory(document.uiMemory ?? {});
	}

	async hasPluginUiMemory(): Promise<boolean> {
		const document = await this.getV2Store().getDocument();
		return document.uiMemory !== undefined;
	}

	async savePluginUiMemory(memory: Partial<EpubPluginUiMemory>): Promise<void> {
		const document = await this.getV2Store().getDocument();
		const current = document.uiMemory ?? {};
		const next = normalizePluginUiMemory({ ...current, ...memory });
		const excerptSettings = (current as { excerptSettings?: unknown }).excerptSettings;
		this.getV2Store().saveSettings({
			uiMemory:
				excerptSettings === undefined
					? next
					: ({ ...next, excerptSettings } as WeaveUiMemory),
		});
	}

	async loadBookshelfSearchQuery(): Promise<string> {
		const saved = (await this.loadPluginUiMemory()).bookshelfSearchQuery;
		return saved.trim();
	}

	async saveBookshelfSearchQuery(query: string): Promise<void> {
		const trimmed = query.trim();
		await this.savePluginUiMemory({
			bookshelfSearchQuery: trimmed ? query : "",
		});
	}

	async loadReaderSettings(): Promise<EpubReaderSettings> {
		const deviceKind = this.getCurrentDeviceKind();
		const document = await this.getV2Store().getDocument();
		const settings = document.readerSettings;
		if (!settings) {
			return { ...this.getDefaultReaderSettingsForCurrentDevice() } as EpubReaderSettings;
		}
		// v2 单份设置：按当前设备归一化并补齐默认值（不做旧默认升级迁移）。
		return normalizeEpubReaderSettingsForDevice(deviceKind, settings);
	}

	async saveReaderSettings(settings: EpubReaderSettings): Promise<void> {
		const deviceKind = this.getCurrentDeviceKind();
		const normalized = normalizeEpubReaderSettingsForDevice(deviceKind, settings);
		// v2 单份设置（桌面/移动共用），去掉 paragraphMode* 死字段。
		const {
			paragraphModeEnabled: _paragraphModeEnabled,
			paragraphModeFontSize: _paragraphModeFontSize,
			paragraphModeFontScale: _paragraphModeFontScale,
			paragraphModeSurfaceStyle: _paragraphModeSurfaceStyle,
			paragraphModeTransitionStyle: _paragraphModeTransitionStyle,
			...v2Settings
		} = normalized;
		this.getV2Store().saveSettings({ readerSettings: v2Settings });
	}

	async loadExcerptSettings(): Promise<EpubExcerptSettings> {
		const document = await this.getV2Store().getDocument();
		const settings = document.uiMemory?.excerptSettings;
		if (settings !== undefined) {
			return this.normalizeExcerptSettings(settings);
		}
		return { ...DEFAULT_EPUB_EXCERPT_SETTINGS };
	}

	async saveExcerptSettings(settings: EpubExcerptSettings): Promise<void> {
		const document = await this.getV2Store().getDocument();
		const uiMemory = document.uiMemory ?? {};
		this.getV2Store().saveSettings({
			uiMemory: {
				...uiMemory,
				excerptSettings: this.normalizeExcerptSettings(settings),
			},
		});
	}

	/** v2：书架显示模式（weave-data.json 顶层 shelfDisplayMode）。 */
	async loadShelfDisplayMode(): Promise<string> {
		const document = await this.getV2Store().getDocument();
		return String(document.shelfDisplayMode || "").trim();
	}

	/** v2：书架显示模式（weave-data.json 顶层 shelfDisplayMode）。 */
	async saveShelfDisplayMode(mode: string): Promise<void> {
		const trimmed = String(mode || "").trim();
		this.getV2Store().saveSettings({ shelfDisplayMode: trimmed });
	}

	private getDefaultReaderSettingsForCurrentDevice(): EpubReaderSettings {
		return getDefaultEpubReaderSettings(this.getCurrentDeviceKind());
	}

	private getDefaultReaderSettingsForDevice(
		deviceKind: EpubReaderSettingsDeviceKind
	): EpubReaderSettings {
		return getDefaultEpubReaderSettings(deviceKind);
	}

	private normalizeExcerptSettings(value: unknown): EpubExcerptSettings {
		return normalizeExcerptSettings(value);
	}

	/**
	 * 旧存储退役：删除已被 weave-data.json 取代的旧数据文件（vault 旧同步目录、
	 * epub-local-state.json、插件缓存扫描索引等），并清理空目录。
	 * 仅执行一次（由 ensureAutomaticDataMigrations 触发）。
	 */
	private async retireLegacyStorageFiles(): Promise<void> {
		if (this.legacyStorageRetired) {
			return;
		}
		this.legacyStorageRetired = true;

		// 先把旧插件目录 cache 文件迁移到统一数据目录，再删除其余旧文件。
		await this.migrateLegacyPluginCacheFiles();

		const adapter = this.app.vault.adapter as {
			remove?: (path: string) => Promise<void>;
		};
		if (typeof adapter.remove !== "function") {
			return;
		}

		const legacyPaths = [
			`${this.basePath}/books.json`,
			`${this.basePath}/reader-settings.json`,
			`${this.basePath}/reader-settings.desktop.json`,
			`${this.basePath}/reader-settings.mobile.json`,
			`${this.basePath}/excerpt-settings.json`,
			`${this.basePath}/canvas-bindings.json`,
			`${this.basePath}/bookshelf-membership.json`,
			`${this.basePath}/epub-source-registry.json`,
			`${this.basePath}/epub-scan-index.json`,
			`${this.basePath}/bookshelf-index.json`,
			this.getUnifiedLocalDataPath(),
			...this.getLegacyUnifiedLocalDataPaths(),
			normalizePath(`${this.getLocalReaderStateRoot()}/reader-settings.desktop.json`),
			normalizePath(`${this.getLocalReaderStateRoot()}/reader-settings.mobile.json`),
			this.getPluginAdapterPath(
				getPluginPathsById(this.app, this.localPluginId).cache.epubScanIndex
			),
		];

		for (const legacyPath of legacyPaths) {
			try {
				if (await this.app.vault.adapter.exists(legacyPath)) {
					await adapter.remove(legacyPath);
				}
			} catch (error) {
				logger.warn(`[EpubStorageService] Failed to remove legacy file ${legacyPath}:`, error);
			}
		}

		for (const rootPath of [this.basePath, this.getLocalReaderStateRoot(), this.getLocalReaderArtifactsRoot()]) {
			await this.removeLegacyScopedFiles(rootPath, [
				"bookmarks.json",
				"highlights.json",
				"notes.json",
				"state.json",
				"last-open-bookmark.json",
				"concealed-texts.json",
			]);
		}

		await Promise.all([
			DirectoryUtils.pruneEmptyDirsUnder(adapter as unknown, this.basePath, {
				preserveRoot: false,
			}),
			DirectoryUtils.pruneEmptyDirsUnder(adapter as unknown, this.getLocalReaderStateRoot(), {
				preserveRoot: false,
			}),
			DirectoryUtils.pruneEmptyDirsUnder(adapter as unknown, this.getLocalReaderArtifactsRoot(), {
				preserveRoot: false,
			}),
		]);
	}

	/**
	 * 旧插件目录 cache 文件迁移到统一数据目录（<dataPath>/cache/...）：
	 * 旧位置存在且新位置不存在时复制内容，随后删除旧文件。
	 */
	private async migrateLegacyPluginCacheFiles(): Promise<void> {
		const adapter = this.app.vault.adapter as {
			read?: (path: string) => Promise<string>;
			write?: (path: string, data: string) => Promise<void>;
			remove?: (path: string) => Promise<void>;
		};
		if (
			typeof adapter.read !== "function" ||
			typeof adapter.write !== "function" ||
			typeof adapter.remove !== "function"
		) {
			return;
		}

		const legacyPluginCache = getPluginPathsById(this.app, this.localPluginId).cache;
		const dataPath = this.resolveDataPath();
		const targets: Array<{ legacy: string; next: string }> = [
			{
				legacy: legacyPluginCache.incrementalReading.epubAnnotationViewSnapshotsCache,
				next: normalizePath(
					`${dataPath}/cache/incremental-reading/epub-annotation-view-snapshots-cache.json`
				),
			},
			{
				legacy: legacyPluginCache.epubParagraphModePositions,
				next: normalizePath(`${dataPath}/cache/epub-paragraph-mode-positions.json`),
			},
		];

		for (const { legacy, next } of targets) {
			try {
				if (!(await this.app.vault.adapter.exists(legacy))) {
					continue;
				}
				if (!(await this.app.vault.adapter.exists(next))) {
					const content = await adapter.read(legacy);
					await DirectoryUtils.ensureDirForFile(this.app.vault.adapter, next);
					await adapter.write(next, content);
				}
				await adapter.remove(legacy);
			} catch (error) {
				logger.warn(
					`[EpubStorageService] Failed to migrate legacy cache file ${legacy}:`,
					error
				);
			}
		}
	}

	private async removeLegacyScopedFiles(rootPath: string, fileNames: string[]): Promise<void> {
		const normalizedRoot = normalizePath(rootPath);
		const adapter = this.app.vault.adapter as {
			list?: (path: string) => Promise<{ files?: string[]; folders?: string[] }>;
			remove?: (path: string) => Promise<void>;
		};
		const listFiles = adapter.list;
		const removeFile = adapter.remove;
		if (
			!normalizedRoot ||
			typeof listFiles !== "function" ||
			typeof removeFile !== "function"
		) {
			return;
		}

		if (!(await this.app.vault.adapter.exists(normalizedRoot))) {
			return;
		}

		const collect = async (folderPath: string): Promise<string[]> => {
			const listing = await listFiles(folderPath);
			const result: string[] = [];
			for (const filePath of listing.files || []) {
				const fileName = filePath.split("/").pop() || "";
				if (fileNames.includes(fileName)) {
					result.push(normalizePath(filePath));
				}
			}
			for (const childFolder of listing.folders || []) {
				result.push(...(await collect(childFolder)));
			}
			return result;
		};

		for (const legacyPath of await collect(normalizedRoot)) {
			try {
				if (await this.app.vault.adapter.exists(legacyPath)) {
					await removeFile(legacyPath);
				}
			} catch (error) {
				logger.warn(`[EpubStorageService] Failed to remove legacy file ${legacyPath}:`, error);
			}
		}
	}

	private remapPath(filePath: string, oldPath: string, newPath: string): string | null {
		const normalizedFilePath = normalizePath(filePath || "");
		if (!normalizedFilePath) {
			return null;
		}

		if (normalizedFilePath === oldPath) {
			return newPath;
		}

		if (normalizedFilePath.startsWith(`${oldPath}/`)) {
			return `${newPath}${normalizedFilePath.slice(oldPath.length)}`;
		}

		return null;
	}
}

type EpubStoragePendingProgressPayload = import("./epub-progress-store").EpubPendingProgressPayload;

function isEpubStorageServiceLike(service: unknown): service is EpubStorageService {
	return typeof service === "object" && service !== null;
}

function readLegacyPendingProgress(service: EpubStorageService): EpubStoragePendingProgressPayload | null {
	if (!isEpubStorageServiceLike(service)) {
		return null;
	}
	const progressStore: unknown = Reflect.get(service as object, "progressStore");
	if (progressStore instanceof EpubProgressStore) {
		return progressStore.readPending();
	}
	const pending: unknown = Reflect.get(service as object, "_pendingProgress");
	return normalizePendingProgressPayload(pending);
}

function clearLegacyPendingProgressTimer(service: EpubStorageService): void {
	if (!isEpubStorageServiceLike(service)) {
		return;
	}
	const progressStore: unknown = Reflect.get(service as object, "progressStore");
	if (progressStore instanceof EpubProgressStore) {
		progressStore.clearTimer();
		return;
	}
	const timer: unknown = Reflect.get(service as object, "_progressDebounceTimer");
	if (typeof timer === "number") {
		window.clearTimeout(timer);
	}
	Reflect.set(service as object, "_progressDebounceTimer", null);
}

function clearLegacyPendingProgress(service: EpubStorageService): void {
	if (!isEpubStorageServiceLike(service)) {
		return;
	}
	const progressStore: unknown = Reflect.get(service as object, "progressStore");
	if (progressStore instanceof EpubProgressStore) {
		progressStore.clearPending();
		return;
	}
	Reflect.set(service as object, "_pendingProgress", null);
}

async function flushEpubStoragePendingProgressState(service: EpubStorageService): Promise<void> {
	if (!isEpubStorageServiceLike(service)) {
		return;
	}
	if (typeof service.flushPendingProgress === "function") {
		await service.flushPendingProgress();
		return;
	}
	clearLegacyPendingProgressTimer(service);
	const pending = readLegacyPendingProgress(service);
	if (!pending) {
		return;
	}
	clearLegacyPendingProgress(service);
	try {
		const canonicalBookId = await service.resolveCanonicalBookId(pending.bookId);
		const book = await service.getBook(canonicalBookId);
		if (book) {
			book.currentPosition = pending.position;
			if (pending.readingStats) {
				book.readingStats = normalizeReadingPaceStats(pending.readingStats);
			}
			book.readingStats.lastReadTime = Date.now();
			await service.writeBookState(book.id, {
				currentPosition: book.currentPosition,
				readingStats: book.readingStats,
			});
		}
	} catch (error) {
		logger.warn("[EpubStorageService] flushPendingProgress failed:", error);
	}
}

/** Flush debounced reading progress even when the service instance predates `flushPendingProgress`. */
export async function flushEpubStoragePendingProgress(service: EpubStorageService): Promise<void> {
	await flushEpubStoragePendingProgressState(service);
}
