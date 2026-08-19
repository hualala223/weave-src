import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { EpubBookmarkService } from "../EpubBookmarkService";
import { getSchemaV2Store } from "../schema-v2-store";

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("../../../tests/mocks/obsidian")>(
		"../../../tests/mocks/obsidian"
	);
	return actual;
});

const DATA_PATH = "CONFIG/STORAGE";
const DATA_FILE = "CONFIG/STORAGE/weave-data.json";

function createMemoryAdapter(initialFiles: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const writes: string[] = [];

	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		read: vi.fn(async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`File not found: ${path}`);
			return value;
		}),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
			writes.push(path);
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (!files.has(oldPath)) throw new Error(`Missing temp: ${oldPath}`);
			files.set(newPath, files.get(oldPath) as string);
			files.delete(oldPath);
		}),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
		mkdir: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
	};
	return { adapter, files, writes };
}

function createApp(initialFiles: Record<string, string> = {}) {
	const { adapter, files, writes } = createMemoryAdapter(initialFiles);
	const app = new App();
	(app as any).vault = {
		adapter,
		getAbstractFileByPath: vi.fn(() => null),
	};
	(app as any).plugins = {
		getPlugin: vi.fn(() => ({ settings: { dataPath: DATA_PATH } })),
	};
	return { app, files, writes };
}

function makeBook(overrides: Record<string, unknown> = {}) {
	return {
		id: "epub-demo",
		filePath: "Books/demo.epub",
		sourceId: "epubsrc-demo",
		sourceFingerprint: "4a9ad58db18a2176c9c0f",
		metadata: {
			title: "Demo",
			author: "Author",
			chapterCount: 5,
		},
		...overrides,
	} as any;
}

/** 预置 v2 聚合（含 notes）。 */
function seedAggregate(files: Map<string, string>, overrides: Record<string, unknown> = {}) {
	const aggregate = {
		id: "epub-demo",
		file: { vaultPath: "Books/demo.epub" },
		meta: { title: "Demo", author: "Author", chapterCount: 5 },
		reading: {
			position: { chapterIndex: 0, cfi: "", percent: 0 },
			stats: { totalReadTime: 0, lastReadTime: 0, createdTime: 0 },
		},
		notes: { bookmarks: [], highlights: [], excerpts: [] },
		audit: { createdAt: 1, updatedAt: 1 },
		...overrides,
	};
	files.set(DATA_FILE, JSON.stringify({ schemaVersion: 2, books: { "epub-demo": aggregate } }));
}

async function flushStore(app: unknown) {
	await getSchemaV2Store(app as any, () => DATA_PATH).flush();
}

function readPersistedBookmarks(files: Map<string, string>): any[] {
	const parsed = JSON.parse(files.get(DATA_FILE) || "{}");
	return parsed.books?.["epub-demo"]?.notes?.bookmarks ?? [];
}

describe("EpubBookmarkService", () => {
	beforeEach(() => {
		getSchemaV2Store(new App(), () => DATA_PATH).resetForTests();
	});

	it("adds a bookmark into the schema v2 notes.bookmarks array", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);

		const result = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
			preview: "预览文本",
		});

		expect(result.created).toBe(true);
		expect(result.bookmark.id).toMatch(/^epub-bm-/);
		expect(result.filePath).toBe("Books/demo.epub");

		const loaded = await service.loadBookmarksForBook(makeBook());
		expect(loaded).toHaveLength(1);
		expect(loaded[0].cfi).toBe("epubcfi(/6/4!/4/2/1:0)");
		expect(loaded[0].chapterTitle).toBe("第三章");

		await flushStore(app);
		expect(readPersistedBookmarks(files)).toHaveLength(1);
	});

	it("dedupes bookmarks with the same normalized cfi, preserving id and createdAt", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);

		const first = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});
		const second = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 46,
			chapterTitle: "第三章",
			createdAt: 1_700_000_100_000,
		});

		expect(second.created).toBe(false);
		expect(second.bookmark.id).toBe(first.bookmark.id);
		expect(second.bookmark.createdAt).toBe(first.bookmark.createdAt);
		expect(await service.loadBookmarksForBook(makeBook())).toHaveLength(1);
	});

	it("rejects addBookmark when the book is missing from the v2 store", async () => {
		const { app } = createApp();
		const service = new EpubBookmarkService(app);

		await expect(
			service.addBookmark(makeBook(), {
				cfi: "epubcfi(/6/4!/4/2/1:0)",
				chapterIndex: 2,
				percent: 45,
				chapterTitle: "第三章",
			})
		).rejects.toThrow();
	});

	it("deletes a bookmark by id and sorts remaining by createdAt desc", async () => {
		const { app, files } = createApp();
		seedAggregate(files, {
			notes: {
				bookmarks: [
					{
						id: "bm-old",
						cfi: "epubcfi(/6/2!/4/2/1:0)",
						chapterIndex: 1,
						percent: 10,
						chapterTitle: "第一章",
						createdAt: 1_700_000_000_000,
					},
					{
						id: "bm-new",
						cfi: "epubcfi(/6/6!/4/2/1:0)",
						chapterIndex: 3,
						percent: 60,
						chapterTitle: "第四章",
						createdAt: 1_700_000_100_000,
					},
				],
				highlights: [],
				excerpts: [],
			},
		});
		const service = new EpubBookmarkService(app);

		expect(await service.loadBookmarksForBook(makeBook())).toHaveLength(2);
		expect((await service.loadBookmarksForBook(makeBook()))[0].id).toBe("bm-new");

		const deleted = await service.deleteBookmark(makeBook(), "bm-old");
		expect(deleted).toBe(true);

		const remaining = await service.loadBookmarksForBook(makeBook());
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("bm-new");

		expect(await service.deleteBookmark(makeBook(), "missing")).toBe(false);
		await flushStore(app);
		expect(readPersistedBookmarks(files)).toHaveLength(1);
	});

	it("counts bookmarks per book", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);

		expect(await service.getBookmarkCountForBook(makeBook())).toBe(0);
		await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
		});
		expect(await service.getBookmarkCountForBook(makeBook())).toBe(1);
	});

	it("returns empty bookmarks for unknown books", async () => {
		const { app } = createApp();
		const service = new EpubBookmarkService(app);

		expect(await service.loadBookmarksForBook(makeBook({ id: "missing" }))).toEqual([]);
		expect(await service.getBookmarkCountForBook(makeBook({ id: "missing" }))).toBe(0);
	});
});
