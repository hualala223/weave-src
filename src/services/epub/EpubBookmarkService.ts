/**
 * 书签服务（schema v2）
 *
 * v2 起书签持久化到 weave-data.json 的 books[bookId].notes.bookmarks，
 * 不再使用书签 md 文件 / frontmatter / weave-data.json `bookmarks` 分区。
 * 书签记录可挂一串书签备注（notes，最新在上）：addBookmarkNote /
 * updateBookmarkNote / deleteBookmarkNote 管理；upsert-by-CFI 重加同一位置时
 * 保留 id / createdAt / notes。
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

export interface EpubBookmarkReadingState {
	currentPosition: ReadingPosition;
	readingStats: ReadingStats;
}

export interface EpubBookmarkNote {
	id: string;
	text: string;
	createdAt: number;
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
	/** 书签备注串（最新在上）。可选字段：旧数据无 notes 时按空串处理。 */
	notes?: EpubBookmarkNote[];
}

export interface EpubBookmarkNoteWriteResult {
	/** 变更后的书签记录；书签不存在时为 null。 */
	bookmark: EpubBookmarkRecord | null;
	/** 新增/更新后的备注；空文本 no-op 时为 null。 */
	note: EpubBookmarkNote | null;
	/** 是否真的写入了变更（空文本 / 内容未变 / 目标缺失时为 false）。 */
	changed: boolean;
}

export interface EpubBookmarkNoteDeleteResult {
	/** 变更后的书签记录；书签不存在时为 null。 */
	bookmark: EpubBookmarkRecord | null;
	deleted: boolean;
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
			.map((bookmark) => normalizeBookmarkNotes(bookmark))
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
				notes: preserved.notes,
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

	private createBookmarkNoteId(bookmarkId: string, createdAt: number, index: number): string {
		const seed = `${bookmarkId}::${createdAt}::${index}`;
		return `epub-bmn-${this.hashString(seed).toString(36)}`;
	}

	/** 在串行化锁内定位书签记录；找不到时返回 null。 */
	private async findBookmarkForWrite(
		book: EpubBook,
		bookmarkId: string
	): Promise<{ aggregate: NonNullable<Awaited<ReturnType<SchemaV2Store["getBook"]>>>; bookmark: EpubBookmarkRecord } | null> {
		const bookId = String(book.id || "").trim();
		const normalizedBookmarkId = String(bookmarkId || "").trim();
		if (!bookId || !normalizedBookmarkId) {
			return null;
		}
		const aggregate = await this.getV2Store().getBook(bookId);
		const bookmark = aggregate?.notes?.bookmarks?.find(
			(item) => String(item.id || "").trim() === normalizedBookmarkId
		);
		if (!aggregate || !bookmark) {
			return null;
		}
		return { aggregate, bookmark };
	}

	private async persistBookmarks(
		aggregate: NonNullable<Awaited<ReturnType<SchemaV2Store["getBook"]>>>,
		bookId: string,
		bookmarks: EpubBookmarkRecord[]
	): Promise<void> {
		this.getV2Store().saveBookNotes(bookId, {
			...aggregate.notes,
			bookmarks,
		});
	}

	private replaceBookmarkInList(
		bookmarks: EpubBookmarkRecord[],
		bookmarkId: string,
		nextBookmark: EpubBookmarkRecord
	): EpubBookmarkRecord[] {
		return bookmarks.map((item) => (item.id === bookmarkId ? nextBookmark : item));
	}

	/**
	 * 新增书签备注：插到备注串最上（最新在上）。
	 * 约定：bookmark 为 null 仅表示书签记录不存在；
	 * 空 / 纯空白文本保存为 no-op（changed=false，bookmark 返回当前记录）。
	 */
	async addBookmarkNote(
		book: EpubBook,
		bookmarkId: string,
		text: string
	): Promise<EpubBookmarkNoteWriteResult> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			const found = await this.findBookmarkForWrite(book, bookmarkId);
			if (!found) {
				return { bookmark: null, note: null, changed: false };
			}
			const { aggregate, bookmark } = found;
			const normalizedText = String(text ?? "");
			if (!normalizedText.trim()) {
				return { bookmark, note: null, changed: false };
			}
			const createdAt = Date.now();
			const note: EpubBookmarkNote = {
				id: this.createBookmarkNoteId(bookmark.id, createdAt, bookmark.notes?.length ?? 0),
				text: normalizedText,
				createdAt,
			};
			const nextBookmark = { ...bookmark, notes: [note, ...(bookmark.notes ?? [])] };
			const nextBookmarks = this.replaceBookmarkInList(aggregate.notes.bookmarks, bookmark.id, nextBookmark);
			await this.persistBookmarks(aggregate, String(book.id || "").trim(), nextBookmarks);
			return { bookmark: nextBookmark, note, changed: true };
		});
	}

	/**
	 * 改写书签备注：仅替换文本，保留原 id / 原时间戳 / 串内位置。
	 * 约定：bookmark 为 null 仅表示书签记录不存在；空文本、备注不存在、
	 * 内容未变均为 no-op（changed=false，bookmark 返回当前记录）。
	 */
	async updateBookmarkNote(
		book: EpubBook,
		bookmarkId: string,
		noteId: string,
		text: string
	): Promise<EpubBookmarkNoteWriteResult> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			const found = await this.findBookmarkForWrite(book, bookmarkId);
			if (!found) {
				return { bookmark: null, note: null, changed: false };
			}
			const { aggregate, bookmark } = found;
			const normalizedText = String(text ?? "");
			if (!normalizedText.trim()) {
				return { bookmark, note: null, changed: false };
			}
			const notes = bookmark.notes ?? [];
			const noteIndex = notes.findIndex((item) => String(item.id || "").trim() === String(noteId || "").trim());
			if (noteIndex < 0) {
				return { bookmark, note: null, changed: false };
			}
			const current = notes[noteIndex];
			if (current.text === normalizedText) {
				return { bookmark, note: current, changed: false };
			}
			const note = { ...current, text: normalizedText };
			const nextNotes = notes.map((item, index) => (index === noteIndex ? note : item));
			const nextBookmark = { ...bookmark, notes: nextNotes };
			const nextBookmarks = this.replaceBookmarkInList(aggregate.notes.bookmarks, bookmark.id, nextBookmark);
			await this.persistBookmarks(aggregate, String(book.id || "").trim(), nextBookmarks);
			return { bookmark: nextBookmark, note, changed: true };
		});
	}

	/**
	 * 删除单条书签备注（仅删该条，不影响其余备注与书签本身）。
	 * 约定：bookmark 为 null 仅表示书签记录不存在；备注不存在为 no-op（deleted=false）。
	 */
	async deleteBookmarkNote(
		book: EpubBook,
		bookmarkId: string,
		noteId: string
	): Promise<EpubBookmarkNoteDeleteResult> {
		return await this.runSerializedBookmarkMutation(book, async () => {
			const found = await this.findBookmarkForWrite(book, bookmarkId);
			if (!found) {
				return { bookmark: null, deleted: false };
			}
			const { aggregate, bookmark } = found;
			const notes = bookmark.notes ?? [];
			const nextNotes = notes.filter(
				(item) => String(item.id || "").trim() !== String(noteId || "").trim()
			);
			if (nextNotes.length === notes.length) {
				return { bookmark, deleted: false };
			}
			const nextBookmark = { ...bookmark, notes: nextNotes };
			const nextBookmarks = this.replaceBookmarkInList(aggregate.notes.bookmarks, bookmark.id, nextBookmark);
			await this.persistBookmarks(aggregate, String(book.id || "").trim(), nextBookmarks);
			return { bookmark: nextBookmark, deleted: true };
		});
	}

	private hashString(value: string): number {
		let hash = 0;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
		}
		return hash;
	}
}

/** 读取时规范化备注串：缺失按空串、按 createdAt 降序（最新在上）。 */
function normalizeBookmarkNotes(bookmark: EpubBookmarkRecord): EpubBookmarkRecord {
	if (!Array.isArray(bookmark.notes) || bookmark.notes.length === 0) {
		return bookmark;
	}
	const notes = [...bookmark.notes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	return { ...bookmark, notes };
}
