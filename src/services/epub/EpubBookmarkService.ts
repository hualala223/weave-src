/**
 * 书签服务（schema v2）
 *
 * v2 起书签持久化到 weave-data.json 的 books[bookId].notes.bookmarks，
 * 不再使用书签 md 文件 / frontmatter / weave-data.json `bookmarks` 分区。
 * 公开 API（loadBookmarksForBook / addBookmark / deleteBookmark / getBookmarkCountForBook）
 * 保持不变，UI 组件无需改动。
 */
import { App } from "obsidian";
import { EpubLinkService } from "./EpubLinkService";
import {
	DEFAULT_EPUB_BOOKMARK_FOLDER,
	normalizeEpubBookmarkFolderPath,
} from "./epub-bookmark-folder-path";
import type { EpubBook, ReadingPosition, ReadingStats } from "./types";
import { getSchemaV2Store, type SchemaV2Store } from "./schema-v2-store";
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

export class EpubBookmarkService {
	private app: App;
	private bookmarkMutationLocks = new Map<string, Promise<void>>();

	constructor(app: App) {
		this.app = app;
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

	getBookmarkFolder(): string {
		return normalizeEpubBookmarkFolderPath(DEFAULT_EPUB_BOOKMARK_FOLDER) || DEFAULT_EPUB_BOOKMARK_FOLDER;
	}

	/** 按书串行化书签变更，避免读-改-写竞态。 */
	private runSerializedBookmarkMutation<T>(book: EpubBook, operation: () => Promise<T>): Promise<T> {
		const lockKey = String(book.id || "").trim() || "epub-book";
		const previous = this.bookmarkMutationLocks.get(lockKey) || Promise.resolve();
		const next = previous.catch(() => undefined).then(operation, operation);
		this.bookmarkMutationLocks.set(
			lockKey,
			next.then(
				() => undefined,
				() => undefined
			)
		);
		return next;
	}

	async loadBookmarksForBook(book: EpubBook): Promise<EpubBookmarkRecord[]> {
		const aggregate = await this.getV2Store().getBook(String(book.id || "").trim());
		if (!aggregate?.notes?.bookmarks) {
			return [];
		}
		return aggregate.notes.bookmarks
			.filter((bookmark) => Boolean(bookmark.cfi))
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
		const bookId = String(book.id || "").trim();
		const aggregate = await this.getV2Store().getBook(bookId);
		if (!aggregate) {
			throw new Error("Book not found in schema v2 store");
		}

		const normalizedCfi = EpubLinkService.normalizeCfi(String(input.cfi || "").trim());
		if (!normalizedCfi) {
			throw new Error("Invalid EPUB bookmark payload");
		}

		const bookmarks = [...(aggregate.notes?.bookmarks ?? [])];
		const existingIndex = bookmarks.findIndex(
			(bookmark) => EpubLinkService.normalizeCfi(bookmark.cfi) === normalizedCfi
		);
		let created = false;
		let bookmark: EpubBookmarkRecord;

		if (existingIndex >= 0) {
			const preserved = bookmarks[existingIndex];
			bookmark = {
				id: preserved.id,
				cfi: normalizedCfi,
				chapterIndex: input.chapterIndex,
				percent: input.percent,
				chapterTitle: String(input.chapterTitle || "").trim(),
				pageNumber: input.pageNumber,
				totalPages: input.totalPages,
				createdAt: preserved.createdAt,
				preview: input.preview,
			};
			bookmarks[existingIndex] = bookmark;
		} else {
			const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
			bookmark = {
				id: this.createBookmarkId(bookId, normalizedCfi, createdAt),
				cfi: normalizedCfi,
				chapterIndex: input.chapterIndex,
				percent: input.percent,
				chapterTitle: String(input.chapterTitle || "").trim(),
				pageNumber: input.pageNumber,
				totalPages: input.totalPages,
				createdAt,
				preview: input.preview,
			};
			bookmarks.unshift(bookmark);
			created = true;
		}

		bookmarks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
		this.getV2Store().saveBookNotes(bookId, {
			...aggregate.notes,
			bookmarks,
		});
		return {
			bookmark,
			created,
			filePath: String(book.filePath || "").trim(),
		};
	}

	async deleteBookmark(book: EpubBook, bookmarkId: string): Promise<boolean> {
		const normalizedBookmarkId = String(bookmarkId || "").trim();
		if (!normalizedBookmarkId) {
			return false;
		}

		return await this.runSerializedBookmarkMutation(book, async () => {
			const bookId = String(book.id || "").trim();
			const aggregate = await this.getV2Store().getBook(bookId);
			if (!aggregate?.notes?.bookmarks) {
				return false;
			}

			const nextBookmarks = aggregate.notes.bookmarks.filter(
				(bookmark) => String(bookmark.id || "").trim() !== normalizedBookmarkId
			);
			if (nextBookmarks.length === aggregate.notes.bookmarks.length) {
				return false;
			}

			this.getV2Store().saveBookNotes(bookId, {
				...aggregate.notes,
				bookmarks: nextBookmarks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
			});
			return true;
		});
	}

	private createBookmarkId(bookId: string, cfi: string, createdAt: number): string {
		const seed = `${bookId}::${createdAt}::${cfi}`;
		return `epub-bm-${this.hashString(seed).toString(36)}`;
	}

	private hashString(value: string): number {
		let hash = 0;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
		}
		return hash;
	}
}
