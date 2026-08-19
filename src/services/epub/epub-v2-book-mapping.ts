/**
 * schema v2 映射：EpubBook（运行时视图） ↔ EpubBookAggregate（持久化聚合）
 *
 * v2 以 books[bookId] 聚合为唯一权威。EpubBook 是 UI/服务层使用的运行时视图，
 * 读写时经本模块双向转换，避免一次性替换上百处组件引用。
 */
import type { EpubBook } from "./types";
import type {
	EpubBookAggregate,
	EpubBookNotes,
	EpubBookReading,
} from "./schema-v2";

/** 空 notes（书尚未有任何标注时）。 */
export function createEmptyEpubBookNotes(): EpubBookNotes {
	return { bookmarks: [], highlights: [], excerpts: [] };
}

/** 空 reading（书尚未打开过时）。 */
export function createEmptyEpubBookReading(): EpubBookReading {
	const now = Date.now();
	return {
		position: { chapterIndex: 0, cfi: "", percent: 0 },
		stats: { totalReadTime: 0, lastReadTime: now, createdTime: now },
	};
}

/** EpubBook → EpubBookAggregate（未提供的子域保留原值或空值）。 */
export function toEpubBookAggregate(
	book: EpubBook,
	extras?: {
		notes?: EpubBookNotes;
		lastPosition?: EpubBookReading["lastPosition"];
		ui?: Record<string, unknown>;
		legacyPaths?: string[];
	}
): EpubBookAggregate {
	const now = Date.now();
	const notes = extras?.notes ?? createEmptyEpubBookNotes();
	return {
		id: String(book.id || "").trim(),
		file: {
			vaultPath: String(book.filePath || "").trim(),
			sourceId: book.sourceId || undefined,
			sourceFingerprint: book.sourceFingerprint || undefined,
			legacyPaths: extras?.legacyPaths,
		},
		meta: book.metadata,
		reading: {
			position: book.currentPosition ?? { chapterIndex: 0, cfi: "", percent: 0 },
			lastPosition: extras?.lastPosition,
			stats: book.readingStats ?? {
				totalReadTime: 0,
				lastReadTime: now,
				createdTime: now,
			},
		},
		notes,
		ui: extras?.ui,
		audit: { createdAt: now, updatedAt: now },
	};
}

/** EpubBookAggregate → EpubBook（运行时视图）。 */
export function toEpubBook(aggregate: EpubBookAggregate): EpubBook {
	return {
		id: aggregate.id,
		filePath: aggregate.file?.vaultPath ?? "",
		sourceId: aggregate.file?.sourceId,
		sourceFingerprint: aggregate.file?.sourceFingerprint,
		metadata: aggregate.meta,
		currentPosition: aggregate.reading?.position ?? {
			chapterIndex: 0,
			cfi: "",
			percent: 0,
		},
		readingStats: aggregate.reading?.stats ?? {
			totalReadTime: 0,
			lastReadTime: Date.now(),
			createdTime: Date.now(),
		},
	};
}
