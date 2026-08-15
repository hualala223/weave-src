import { App, normalizePath } from "obsidian";
import { sanitizeForSync } from "../../utils/sync-safe-filename";
import { EpubLinkService } from "./EpubLinkService";
import {
	areEpubBookmarkAnalyticsEquivalent,
	buildEpubBookmarkAnalytics,
	readEpubBookmarkAnalyticsFromFrontmatter,
} from "./epub-bookmark-analytics";
import { resolveEpubBookmarkFolderForApp } from "./epub-bookmark-vault-path";
import {
	EPUB_BOOKMARK_DATA_FILE_PREFIX,
} from "./epub-bookmark-folder-path";
import { getEpubStorageService } from "./epub-storage-access";
import type {
	EpubBookmarkAnalytics,
	EpubBookmarkUserMetadata,
} from "./epub-bookmark-page-types";
import {
	EPUB_BOOKMARK_ACCEPTED_FORMATS,
	EPUB_BOOKMARK_FILE_FORMAT_V3,
} from "./epub-bookmark-page-types";
import { deriveEpubBookmarkDisplayTitle } from "./epub-bookmark-display-title";
import { ensureEpubBookmarkCoverPath } from "./epub-bookmark-cover";
import { normalizeReadingPaceStats } from "./reading-pace";
import type { ReaderHighlightInput } from "./reader-engine-types";
import type { EpubBook, ReadingPosition, ReadingStats } from "./types";
import { unknownPlainText } from "../../utils/unknown-plain-text";
import {
	getWeaveDataStore,
	type WeaveDataStore,
} from "./weave-data-store";
import {
	DEFAULT_DATA_PATH,
	normalizeDataPath,
} from "../../config/paths";
import { CURRENT_PLUGIN_ID } from "../../config/plugin-runtime";

export {
	DEFAULT_EPUB_BOOKMARK_FOLDER,
	EPUB_BOOKMARK_DATA_FILE_PREFIX,
	normalizeEpubBookmarkFolderPath,
} from "./epub-bookmark-folder-path";
const EPUB_BOOKMARK_FILE_FORMAT = EPUB_BOOKMARK_FILE_FORMAT_V3;

export type { EpubBookmarkAnalytics } from "./epub-bookmark-page-types";
export { buildEpubBookmarkAnalytics } from "./epub-bookmark-analytics";

export interface EpubBookmarkReadingState {
	currentPosition: ReadingPosition;
	readingStats: ReadingStats;
}

export interface EpubBookmarkRecord {
	id: string;
	cfi: string;
	chapterIndex: number;
	percent: number;
	chapterTitle: string;
	pageNumber?: number;
	totalPages?: number;
	createdAt: number;
	preview?: string;
}

export interface EpubBookmarkCreateInput {
	cfi: string;
	chapterIndex: number;
	percent: number;
	chapterTitle: string;
	pageNumber?: number;
	totalPages?: number;
	createdAt?: number;
	preview?: string;
}

export interface EpubBookmarkWriteResult {
	bookmark: EpubBookmarkRecord;
	created: boolean;
	filePath: string;
}

interface EpubBookmarkFileFrontmatter {
	format: string;
	weave_epub_bookmark_file: boolean;
	stableKey: string;
	bookId: string;
	sourceId?: string;
	sourceFingerprint?: string;
	bookPath: string;
	displayTitle?: string;
	bookTitle: string;
	bookAuthor?: string;
	bookLanguage?: string;
	publisher?: string;
	isbn?: string;
	publishDate?: string;
	subjects?: string[];
	description?: string;
	translator?: string;
	coverPath?: string;
	wordCount?: number;
	chapterCount?: number;
	updatedAt: number;
	bookmarks: EpubBookmarkRecord[];
	readingState?: EpubBookmarkReadingState;
	analytics?: EpubBookmarkAnalytics;
	user?: EpubBookmarkUserMetadata;
}

/** Normalize title punctuation so bookmark filenames stay stable across platforms. */
export function normalizeBookmarkTitleForFileName(title: string): string {
	return String(title || "").replace(/[\u2022\u00B7\u2219\u30FB\u0387\u22C5\u2027]/g, "-");
}

/** Hex length taken from `sourceFingerprint` when building a short `stableKey` / filename suffix. */
export const EPUB_BOOKMARK_STABLE_KEY_FINGERPRINT_HEX_LENGTH = 12;

function isEphemeralEpubRuntimeId(value: string): boolean {
	return /^epub-[0-9a-z]+$/i.test(String(value || "").trim());
}

/**
 * Short, vault-safe book identity for bookmark filenames and frontmatter `stableKey`.
 * Full `sourceFingerprint` remains in YAML for rename/move reconciliation.
 */
export function buildEpubBookmarkStableKey(input: {
	sourceFingerprint?: string;
	sourceId?: string;
	id?: string;
	title?: string;
}): string {
	const fingerprint = String(input.sourceFingerprint || "")
		.trim()
		.toLowerCase();
	if (fingerprint) {
		const prefix = fingerprint.slice(0, EPUB_BOOKMARK_STABLE_KEY_FINGERPRINT_HEX_LENGTH);
		return sanitizeForSync(`epubsrc-${prefix}`, 20);
	}

	const sourceId = String(input.sourceId || "").trim();
	if (sourceId && !isEphemeralEpubRuntimeId(sourceId)) {
		return sanitizeForSync(sourceId, 32);
	}

	const bookId = String(input.id || "").trim();
	if (bookId && !isEphemeralEpubRuntimeId(bookId)) {
		return sanitizeForSync(bookId, 32);
	}

	const title = String(input.title || "").trim();
	return sanitizeForSync(title, 32) || "epub-book";
}

/** Legacy filename suffixes that used the full fingerprint or long source id in the path. */
export function buildLegacyEpubBookmarkStableKeySuffixes(input: {
	sourceFingerprint?: string;
	sourceId?: string;
	canonicalStableKey: string;
}): string[] {
	const suffixes = new Set<string>();
	const canonical = String(input.canonicalStableKey || "").trim();
	const addSuffix = (stableKey: string) => {
		const normalized = String(stableKey || "").trim();
		if (!normalized || normalized === canonical) {
			return;
		}
		suffixes.add(`--${normalized}.md`);
	};

	const fingerprint = String(input.sourceFingerprint || "").trim();
	if (fingerprint) {
		addSuffix(sanitizeForSync(fingerprint, 56));
	}

	const sourceId = String(input.sourceId || "").trim();
	if (sourceId) {
		addSuffix(sanitizeForSync(sourceId, 56));
	}

	return [...suffixes];
}

export function buildEpubBookmarkFileBaseName(title: string): string {
	const normalizedTitle = sanitizeForSync(
		normalizeBookmarkTitleForFileName(String(title || "").trim()),
		64
	);
	return `${EPUB_BOOKMARK_DATA_FILE_PREFIX}${normalizedTitle || "EPUB"}`;
}

export function buildEpubBookmarkFileName(title: string): string {
	return `${buildEpubBookmarkFileBaseName(title)}.md`;
}

export function buildEpubBookmarkFileNameCandidates(input: {
	title: string;
	author?: string;
	epubBaseName?: string;
}): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (fileName: string) => {
		const normalized = String(fileName || "").trim();
		if (!normalized || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		candidates.push(normalized);
	};

	push(buildEpubBookmarkFileName(input.title));

	const baseName = buildEpubBookmarkFileBaseName(input.title);
	const author = String(input.author || "").trim();
	if (author) {
		push(`${baseName} - ${sanitizeForSync(author, 32)}.md`);
	}

	const epubBaseName = String(input.epubBaseName || "").trim();
	if (epubBaseName) {
		push(`${baseName} - ${sanitizeForSync(epubBaseName, 32)}.md`);
	}

	for (let index = 2; index <= 500; index += 1) {
		push(`${baseName} ${index}.md`);
	}

	return candidates;
}

/** Legacy `{title}--{id}.md` filenames (pre `data_` naming). */
export function buildLegacyEpubBookmarkTitleIdPrefix(title: string): string | null {
	const titleSegment = sanitizeForSync(
		normalizeBookmarkTitleForFileName(String(title || "").trim()),
		64
	);
	if (!titleSegment) {
		return null;
	}
	return `${titleSegment}--`;
}

export class EpubBookmarkService {
	private app: App;
	private linkService: EpubLinkService;
	private bookmarkFileLocks = new Map<string, Promise<void>>();

	constructor(app: App) {
		this.app = app;
		this.linkService = new EpubLinkService(app);
	}

	private runSerializedBookmarkMutation<T>(book: EpubBook, operation: () => Promise<T>): Promise<T> {
		const lockKey =
			this.buildStableKey(book) || String(book.id || "").trim() || "epub-book";
		const previous = this.bookmarkFileLocks.get(lockKey) || Promise.resolve();
		const next = previous.catch(() => undefined).then(operation, operation);
		this.bookmarkFileLocks.set(
			lockKey,
			next.then(
				() => undefined,
				() => undefined
			)
		);
		return next;
	}

	getBookmarkFolder(): string {
		return resolveEpubBookmarkFolderForApp(this.app);
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

	private getDataStore(): WeaveDataStore {
		return getWeaveDataStore(this.app, () => this.resolveDataPath());
	}

	async loadBookmarksForBook(book: EpubBook): Promise<EpubBookmarkRecord[]> {
		const fileData = await this.readBookmarkRecordForBook(book);
		if (!fileData) {
			return [];
		}
		return [...fileData.bookmarks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	}

	async getBookmarkCountForBook(book: EpubBook): Promise<number> {
		return (await this.loadBookmarksForBook(book)).length;
	}

	async addBookmark(
		book: EpubBook,
		input: EpubBookmarkCreateInput
	): Promise<EpubBookmarkWriteResult> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			return await this.addBookmarkInternal(book, input);
		});
	}

	private async addBookmarkInternal(
		book: EpubBook,
		input: EpubBookmarkCreateInput
	): Promise<EpubBookmarkWriteResult> {
		const existing =
			(await this.readBookmarkRecordForBook(book)) ?? this.createEmptyFileFrontmatter(book);
		const normalizedBookmark = this.normalizeBookmarkRecord(
			{
				...input,
				id: this.createBookmarkId(existing.stableKey, input.cfi, input.createdAt ?? Date.now()),
			},
			existing.stableKey
		);
		if (!normalizedBookmark) {
			throw new Error("Invalid EPUB bookmark payload");
		}

		const normalizedCfi = EpubLinkService.normalizeCfi(normalizedBookmark.cfi);
		const existingIndex = existing.bookmarks.findIndex(
			(bookmark) => EpubLinkService.normalizeCfi(bookmark.cfi) === normalizedCfi
		);
		let created = false;
		let bookmark = normalizedBookmark;

		if (existingIndex >= 0) {
			const preserved = existing.bookmarks[existingIndex];
			bookmark = {
				...normalizedBookmark,
				id: preserved.id,
				createdAt: preserved.createdAt,
			};
			existing.bookmarks[existingIndex] = bookmark;
		} else {
			created = true;
			existing.bookmarks = [bookmark, ...existing.bookmarks];
		}

		const merged = this.mergeBookIdentity(existing, book);
		Object.assign(existing, merged);
		existing.updatedAt = Date.now();
		existing.bookmarks = existing.bookmarks
			.filter((item) => Boolean(item.cfi))
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		await this.writeBookmarkRecord(existing);
		return {
			bookmark,
			created,
			filePath: existing.bookPath,
		};
	}

	async deleteBookmark(book: EpubBook, bookmarkId: string): Promise<boolean> {
		const normalizedBookmarkId = String(bookmarkId || "").trim();
		if (!normalizedBookmarkId) {
			return false;
		}

		return await this.runSerializedBookmarkMutation(book, async () => {
			const existing = await this.readBookmarkRecordForBook(book);
			if (!existing) {
				return false;
			}

			const nextBookmarks = existing.bookmarks.filter(
				(bookmark) => String(bookmark.id || "").trim() !== normalizedBookmarkId
			);
			if (nextBookmarks.length === existing.bookmarks.length) {
				return false;
			}

			existing.bookmarks = nextBookmarks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
			existing.updatedAt = Date.now();
			await this.writeBookmarkRecord(existing);
			return true;
		});
	}

	async readReadingState(book: EpubBook): Promise<EpubBookmarkReadingState | null> {
		const record = await this.readBookmarkRecordForBook(book);
		return record?.readingState ?? null;
	}

	async readBookmarkSnapshotForBook(
		book: EpubBook
	): Promise<EpubBookmarkFileFrontmatter | null> {
		return await this.readBookmarkRecordForBook(book);
	}

	async readReadingStateByBookPath(filePath: string): Promise<EpubBookmarkReadingState | null> {
		const snapshot = await this.findBookmarkSnapshotByBookPath(filePath);
		return snapshot?.readingState ?? null;
	}

	async findBookmarkSnapshotByBookPath(
		filePath: string
	): Promise<EpubBookmarkFileFrontmatter | null> {
		const normalizedPath = normalizePath(String(filePath || "").trim());
		if (!normalizedPath) {
			return null;
		}

		const section =
			await this.getDataStore().getSection<Record<string, unknown>>("bookmarks");
		if (!section || typeof section !== "object") {
			return null;
		}

		for (const raw of Object.values(section)) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const record = this.normalizeBookmarkFileFrontmatter(raw as Record<string, unknown>);
			if (record && normalizePath(record.bookPath) === normalizedPath) {
				return record;
			}
		}

		return null;
	}

	async writeReadingState(
		book: EpubBook,
		state: EpubBookmarkReadingState
	): Promise<string> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			const existing =
				(await this.readBookmarkRecordForBook(book)) ||
				this.createEmptyFileFrontmatter(book);
			const nextFrontmatter = this.mergeBookIdentity(existing, book);
			nextFrontmatter.updatedAt = Date.now();
			nextFrontmatter.readingState = this.normalizeReadingState(state) ?? undefined;
			await this.writeBookmarkRecord(nextFrontmatter);
			return nextFrontmatter.bookPath;
		});
	}

	async syncBookDisplayMetadata(book: EpubBook): Promise<void> {
		const existing = await this.readBookmarkRecordForBook(book);
		if (!existing) {
			return;
		}
		await this.writeBookmarkRecord(this.mergeBookIdentity(existing, book));
	}

	async syncAnalytics(book: EpubBook, highlights: ReaderHighlightInput[]): Promise<string | null> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			const existing =
				(await this.readBookmarkRecordForBook(book)) ||
				this.createEmptyFileFrontmatter(book);
			const excerptSettings = await getEpubStorageService(this.app).loadExcerptSettings();
			const nextAnalytics = buildEpubBookmarkAnalytics(highlights, Date.now(), {
				strikethroughDisplayMode: excerptSettings.strikethroughDisplayMode,
				showStrikethroughInSidebar: excerptSettings.showStrikethroughInSidebar,
			});
			if (areEpubBookmarkAnalyticsEquivalent(existing.analytics, nextAnalytics)) {
				return existing.bookPath;
			}
			const nextFrontmatter = this.mergeBookIdentity(existing, book);
			nextFrontmatter.analytics = nextAnalytics;
			nextFrontmatter.updatedAt = Date.now();
			await this.writeBookmarkRecord(nextFrontmatter);
			return nextFrontmatter.bookPath;
		});
	}

	async updateBookFileReferences(oldPath: string, newPath: string): Promise<number> {
		const normalizedOldPath = normalizePath(String(oldPath || "").trim());
		const normalizedNewPath = normalizePath(String(newPath || "").trim());
		if (!normalizedOldPath || !normalizedNewPath || normalizedOldPath === normalizedNewPath) {
			return 0;
		}

		const store = this.getDataStore();
		const section =
			(await store.getSection<Record<string, unknown>>("bookmarks")) || {};
		const next = { ...section };
		let updated = 0;
		let changed = false;

		for (const key of Object.keys(section)) {
			const raw = section[key];
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const record = this.normalizeBookmarkFileFrontmatter(raw as Record<string, unknown>);
			if (!record || normalizePath(record.bookPath) !== normalizedOldPath) {
				continue;
			}
			record.bookPath = normalizedNewPath;
			record.updatedAt = Date.now();
			delete next[key];
			next[normalizedNewPath] = record;
			changed = true;
			updated += 1;
		}

		if (changed) {
			store.updateSection("bookmarks", next);
		}
		return updated;
	}

	private async readBookmarkRecordForBook(
		book: EpubBook
	): Promise<EpubBookmarkFileFrontmatter | null> {
		const bookPath = normalizePath(String(book.filePath || "").trim());
		if (!bookPath) {
			return null;
		}
		const section =
			await this.getDataStore().getSection<Record<string, unknown>>("bookmarks");
		const raw = section && typeof section === "object" ? section[bookPath] : undefined;
		if (!raw || typeof raw !== "object") {
			return null;
		}
		return this.normalizeBookmarkFileFrontmatter(raw as Record<string, unknown>);
	}

	private async writeBookmarkRecord(
		frontmatter: EpubBookmarkFileFrontmatter
	): Promise<void> {
		const prepared = await this.prepareFrontmatterForWrite(frontmatter);
		const bookPath = normalizePath(String(prepared.bookPath || "").trim());
		if (!bookPath) {
			throw new Error("Bookmark bookPath is required");
		}

		const store = this.getDataStore();
		const section =
			(await store.getSection<Record<string, unknown>>("bookmarks")) || {};
		store.updateSection("bookmarks", { ...section, [bookPath]: prepared });
	}

	private buildStableKey(book: EpubBook): string {
		return buildEpubBookmarkStableKey({
			sourceFingerprint: book.sourceFingerprint,
			sourceId: book.sourceId,
			id: book.id,
			title: this.resolveBookTitle(book),
		});
	}

	private resolveBookTitle(book: EpubBook): string {
		return (
			String(book.metadata?.title || "").trim() ||
			EpubLinkService.extractShortBookName(String(book.filePath || "").trim()) ||
			"EPUB"
		);
	}

	private resolveBookAuthor(book: EpubBook): string | undefined {
		const author = String(book.metadata?.author || "").trim();
		return author || undefined;
	}

	private createEmptyFileFrontmatter(book: EpubBook): EpubBookmarkFileFrontmatter {
		return this.mergeBookIdentity(
			{
				format: EPUB_BOOKMARK_FILE_FORMAT,
				weave_epub_bookmark_file: true,
				stableKey: this.buildStableKey(book),
				bookId: String(book.id || "").trim(),
				bookPath: normalizePath(String(book.filePath || "").trim()),
				bookTitle: this.resolveBookTitle(book),
				updatedAt: Date.now(),
				bookmarks: [],
			},
			book
		);
	}

	private mergeBookIdentity(
		frontmatter: EpubBookmarkFileFrontmatter,
		book: EpubBook
	): EpubBookmarkFileFrontmatter {
		const metadata = book.metadata;
		const bookTitle = this.resolveBookTitle(book);
		const bookAuthor = this.resolveBookAuthor(book);
		const bookPath = normalizePath(String(book.filePath || "").trim());
		const displayTitle = deriveEpubBookmarkDisplayTitle({
			bookTitle,
			bookAuthor,
			bookPath,
		});
		return {
			...frontmatter,
			format: EPUB_BOOKMARK_FILE_FORMAT,
			weave_epub_bookmark_file: true,
			stableKey: this.buildStableKey(book),
			bookId: String(book.id || "").trim(),
			sourceId: typeof book.sourceId === "string" ? book.sourceId : undefined,
			sourceFingerprint:
				typeof book.sourceFingerprint === "string" ? book.sourceFingerprint : undefined,
			bookPath,
			displayTitle: frontmatter.displayTitle || displayTitle,
			bookTitle,
			bookAuthor,
			bookLanguage: String(metadata?.language || "").trim() || frontmatter.bookLanguage,
			publisher: metadata?.publisher || frontmatter.publisher,
			isbn: metadata?.isbn || frontmatter.isbn,
			publishDate: metadata?.publishDate || frontmatter.publishDate,
			subjects:
				metadata?.subjects && metadata.subjects.length > 0
					? metadata.subjects
					: frontmatter.subjects,
			description: metadata?.description || frontmatter.description,
			translator: metadata?.translator || frontmatter.translator,
			coverPath: frontmatter.coverPath,
			wordCount:
				typeof metadata?.wordCount === "number" && metadata.wordCount > 0
					? metadata.wordCount
					: frontmatter.wordCount,
			chapterCount:
				typeof metadata?.chapterCount === "number" && metadata.chapterCount > 0
					? metadata.chapterCount
					: frontmatter.chapterCount,
		};
	}

	private createBookmarkId(stableKey: string, cfi: string, createdAt: number): string {
		const seed = `${stableKey}::${createdAt}::${cfi}`;
		return `epub-bm-${this.hashString(seed).toString(36)}`;
	}

	private hashString(value: string): number {
		let hash = 0;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
		}
		return hash;
	}

	private normalizeBookmarkFileFrontmatter(
		value: Record<string, unknown>
	): EpubBookmarkFileFrontmatter | null {
		const format = unknownPlainText(value.format).trim();
		const stableKey = unknownPlainText(value.stableKey).trim();
		const bookId = unknownPlainText(value.bookId).trim();
		const bookPath = normalizePath(unknownPlainText(value.bookPath).trim());
		const bookTitle = unknownPlainText(value.bookTitle).trim();
		if (
			(format &&
				!EPUB_BOOKMARK_ACCEPTED_FORMATS.includes(
					format as (typeof EPUB_BOOKMARK_ACCEPTED_FORMATS)[number]
				)) ||
			!stableKey ||
			!bookPath
		) {
			return null;
		}
		return {
			format: EPUB_BOOKMARK_FILE_FORMAT,
			weave_epub_bookmark_file: true,
			stableKey,
			bookId,
			sourceId: typeof value.sourceId === "string" ? value.sourceId : undefined,
			sourceFingerprint:
				typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : undefined,
			bookPath,
			displayTitle:
				typeof value.displayTitle === "string" ? value.displayTitle.trim() : undefined,
			bookTitle,
			bookAuthor: typeof value.bookAuthor === "string" ? value.bookAuthor : undefined,
			bookLanguage: typeof value.bookLanguage === "string" ? value.bookLanguage : undefined,
			publisher: typeof value.publisher === "string" ? value.publisher : undefined,
			isbn: typeof value.isbn === "string" ? value.isbn : undefined,
			publishDate: typeof value.publishDate === "string" ? value.publishDate : undefined,
			subjects: Array.isArray(value.subjects)
				? value.subjects.map((item) => String(item || "").trim()).filter(Boolean)
				: undefined,
			description: typeof value.description === "string" ? value.description : undefined,
			translator: typeof value.translator === "string" ? value.translator : undefined,
			coverPath: typeof value.coverPath === "string" ? value.coverPath : undefined,
			wordCount: typeof value.wordCount === "number" ? value.wordCount : undefined,
			chapterCount: typeof value.chapterCount === "number" ? value.chapterCount : undefined,
			updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
			bookmarks: this.normalizeBookmarkRecords(value.bookmarks, stableKey),
			readingState: this.normalizeReadingState(value.readingState) || undefined,
			analytics: readEpubBookmarkAnalyticsFromFrontmatter(value) || undefined,
			user: this.normalizeUserMetadata(value.user) || undefined,
		};
	}

	private normalizeUserMetadata(value: unknown): EpubBookmarkUserMetadata | null {
		if (!value || typeof value !== "object") {
			return null;
		}
		const record = value as Record<string, unknown>;
		const tags = Array.isArray(record.tags)
			? record.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
			: undefined;
		const rating =
			typeof record.rating === "number" && Number.isFinite(record.rating)
				? record.rating
				: record.rating === null
					? null
					: undefined;
		const priority =
			typeof record.priority === "string" && record.priority.trim()
				? record.priority.trim()
				: undefined;
		const notes =
			typeof record.notes === "string" && record.notes.trim() ? record.notes.trim() : undefined;

		if (!tags?.length && rating == null && !priority && !notes) {
			return null;
		}

		return {
			tags,
			rating,
			priority,
			notes,
		};
	}

	private normalizeReadingState(value: unknown): EpubBookmarkReadingState | null {
		if (!value || typeof value !== "object") {
			return null;
		}
		const record = value as Record<string, unknown>;
		const currentPosition = this.normalizeReadingPosition(record.currentPosition);
		const readingStats = this.normalizeReadingStats(record.readingStats);
		if (!currentPosition && !readingStats) {
			return null;
		}
		const now = Date.now();
		return {
			currentPosition: currentPosition ?? { chapterIndex: 0, cfi: "", percent: 0 },
			readingStats:
				readingStats ?? normalizeReadingPaceStats({ createdTime: now, lastReadTime: now }),
		};
	}

	private normalizeReadingPosition(value: unknown): ReadingPosition | null {
		if (!value || typeof value !== "object") {
			return null;
		}
		const position = value as Partial<ReadingPosition>;
		const cfi = String(position.cfi || "").trim();
		if (!cfi && typeof position.percent !== "number") {
			return null;
		}
		return {
			chapterIndex: typeof position.chapterIndex === "number" ? position.chapterIndex : 0,
			cfi,
			percent: typeof position.percent === "number" ? position.percent : 0,
		};
	}

	private normalizeReadingStats(value: unknown): ReadingStats | null {
		if (!value || typeof value !== "object") {
			return null;
		}
		return normalizeReadingPaceStats(value as Partial<ReadingStats>);
	}

	private normalizeBookmarkRecords(value: unknown, stableKey: string): EpubBookmarkRecord[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.map((item) => this.normalizeBookmarkRecord(item, stableKey))
			.filter((item): item is EpubBookmarkRecord => Boolean(item))
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	}

	private normalizeBookmarkRecord(value: unknown, stableKey: string): EpubBookmarkRecord | null {
		if (!value || typeof value !== "object") {
			return null;
		}
		const record = value as Record<string, unknown>;
		const cfi = EpubLinkService.normalizeCfi(unknownPlainText(record.cfi).trim());
		if (!cfi) {
			return null;
		}
		const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
		const chapterTitle = unknownPlainText(record.chapterTitle).trim();
		return {
			id:
				typeof record.id === "string" && record.id.trim().length > 0
					? record.id.trim()
					: this.createBookmarkId(stableKey, cfi, createdAt),
			cfi,
			chapterIndex: typeof record.chapterIndex === "number" ? record.chapterIndex : 0,
			percent: typeof record.percent === "number" ? record.percent : 0,
			chapterTitle,
			pageNumber: typeof record.pageNumber === "number" ? record.pageNumber : undefined,
			totalPages: typeof record.totalPages === "number" ? record.totalPages : undefined,
			createdAt,
			preview: typeof record.preview === "string" ? record.preview : undefined,
		};
	}

	private async prepareFrontmatterForWrite(
		frontmatter: EpubBookmarkFileFrontmatter
	): Promise<EpubBookmarkFileFrontmatter> {
		const displayTitle =
			frontmatter.displayTitle ||
			deriveEpubBookmarkDisplayTitle({
				bookTitle: frontmatter.bookTitle,
				bookAuthor: frontmatter.bookAuthor,
				bookPath: frontmatter.bookPath,
			});
		const coverPath =
			(await ensureEpubBookmarkCoverPath(this.app, {
				bookPath: frontmatter.bookPath,
				stableKey: frontmatter.stableKey,
				dataPath: this.resolveDataPath(),
				existingCoverPath: frontmatter.coverPath,
			})) || frontmatter.coverPath;

		return {
			...frontmatter,
			format: EPUB_BOOKMARK_FILE_FORMAT,
			displayTitle,
			coverPath,
			user: frontmatter.user ?? {
				tags: [],
				rating: null,
				priority: "",
				notes: "",
			},
		};
	}
}
