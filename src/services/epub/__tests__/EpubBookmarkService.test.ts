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

describe("EpubBookmarkService bookmark notes", () => {
	beforeEach(() => {
		getSchemaV2Store(new App(), () => DATA_PATH).resetForTests();
	});

	async function seedBookmarkWithNotes(files: Map<string, string>, bookmarks: Record<string, unknown>[]) {
		seedAggregate(files, {
			notes: {
				bookmarks,
				highlights: [],
				excerpts: [],
			},
		});
	}

	it("adds a bookmark note at the top of the thread and persists it", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});

		const first = await service.addBookmarkNote(makeBook(), created.bookmark.id, "第一条备注");
		expect(first.changed).toBe(true);
		expect(first.note?.id).toMatch(/^epub-bmn-/);
		expect(first.bookmark?.notes?.[0].text).toBe("第一条备注");

		const second = await service.addBookmarkNote(makeBook(), created.bookmark.id, "第二条更新鲜");
		expect(second.changed).toBe(true);
		expect(second.bookmark?.notes).toHaveLength(2);
		expect(second.bookmark?.notes?.[0].text).toBe("第二条更新鲜");
		expect((second.bookmark?.notes?.[0].createdAt ?? 0) >= (second.bookmark?.notes?.[1].createdAt ?? 1)).toBe(true);

		await flushStore(app);
		const persisted = readPersistedBookmarks(files)[0];
		expect(persisted.notes).toHaveLength(2);
		expect(persisted.notes[0].text).toBe("第二条更新鲜");
	});

	it("rejects empty or whitespace-only note text as a no-op", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});

		const result = await service.addBookmarkNote(makeBook(), created.bookmark.id, "   \n  ");
		expect(result.changed).toBe(false);
		expect(result.note).toBeNull();
		expect(result.bookmark?.id).toBe(created.bookmark.id);

		await flushStore(app);
		expect(readPersistedBookmarks(files)[0].notes ?? []).toEqual([]);
	});

	it("returns changed=false when the bookmark is missing", async () => {
		const { app } = createApp();
		const service = new EpubBookmarkService(app);

		const result = await service.addBookmarkNote(makeBook(), "missing-bookmark", "备注");
		expect(result.changed).toBe(false);
		expect(result.bookmark).toBeNull();
		expect(result.note).toBeNull();
	});

	it("updates a note in place, keeping its id, createdAt and thread position", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});
		const added = await service.addBookmarkNote(makeBook(), created.bookmark.id, "有错字");
		const noteId = added.note?.id ?? "";
		const originalCreatedAt = added.note?.createdAt ?? -1;
		expect(noteId).toBeTruthy();

		const updated = await service.updateBookmarkNote(makeBook(), created.bookmark.id, noteId, "改好了");
		expect(updated.changed).toBe(true);
		expect(updated.note?.id).toBe(noteId);
		expect(updated.note?.createdAt).toBe(originalCreatedAt);
		expect(updated.bookmark?.notes).toHaveLength(1);
		expect(updated.bookmark?.notes?.[0].text).toBe("改好了");

		const same = await service.updateBookmarkNote(makeBook(), created.bookmark.id, noteId, "改好了");
		expect(same.changed).toBe(false);

		const empty = await service.updateBookmarkNote(makeBook(), created.bookmark.id, noteId, "  ");
		expect(empty.changed).toBe(false);

		await flushStore(app);
		const persisted = readPersistedBookmarks(files)[0];
		expect(persisted.notes[0].text).toBe("改好了");
		expect(persisted.notes[0].id).toBe(noteId);
		expect(persisted.notes[0].createdAt).toBe(originalCreatedAt);
	});

	it("returns changed=false when updating a missing note", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});

		const result = await service.updateBookmarkNote(makeBook(), created.bookmark.id, "missing-note", "备注");
		expect(result.changed).toBe(false);
		expect(result.bookmark?.id).toBe(created.bookmark.id);
		expect(result.note).toBeNull();
	});

	it("deletes a single note without touching the others or the bookmark", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});
		const firstResult = await service.addBookmarkNote(makeBook(), created.bookmark.id, "第一");
		const secondResult = await service.addBookmarkNote(makeBook(), created.bookmark.id, "第二");
		const firstId = firstResult.note?.id ?? "";
		const secondId = secondResult.note?.id ?? "";
		expect(firstId).toBeTruthy();
		expect(secondId).toBeTruthy();

		const result = await service.deleteBookmarkNote(makeBook(), created.bookmark.id, firstId);
		expect(result.deleted).toBe(true);
		expect(result.bookmark?.notes?.map((n) => n.id)).toEqual([secondId]);

		const missing = await service.deleteBookmarkNote(makeBook(), created.bookmark.id, "missing");
		expect(missing.deleted).toBe(false);
		expect(missing.bookmark?.id).toBe(created.bookmark.id);

		await flushStore(app);
		expect(readPersistedBookmarks(files)[0].notes).toHaveLength(1);
	});

	it("preserves notes when re-adding a bookmark for the same cfi (upsert-by-CFI)", async () => {
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
		const added = await service.addBookmarkNote(makeBook(), first.bookmark.id, "重加书签不能丢的备注");
		expect(added.changed).toBe(true);

		const second = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 46,
			chapterTitle: "第三章",
			createdAt: 1_700_000_100_000,
		});
		expect(second.created).toBe(false);
		expect(second.bookmark.id).toBe(first.bookmark.id);
		expect(second.bookmark.notes).toHaveLength(1);
		expect(second.bookmark.notes?.[0].text).toBe("重加书签不能丢的备注");

		await flushStore(app);
		expect(readPersistedBookmarks(files)[0].notes?.[0].text).toBe("重加书签不能丢的备注");
	});

	it("loads legacy bookmarks without notes and normalizes note order newest-first", async () => {
		const { app, files } = createApp();
		await seedBookmarkWithNotes(files, [
			{
				id: "bm-1",
				cfi: "epubcfi(/6/2!/4/2/1:0)",
				chapterIndex: 1,
				percent: 10,
				chapterTitle: "第一章",
				createdAt: 1_700_000_000_000,
				notes: [
					{ id: "bn-old", text: "旧", createdAt: 1_700_000_000_000 },
					{ id: "bn-new", text: "新", createdAt: 1_700_000_100_000 },
				],
			},
			{
				id: "bm-2",
				cfi: "epubcfi(/6/6!/4/2/1:0)",
				chapterIndex: 3,
				percent: 60,
				chapterTitle: "第四章",
				createdAt: 1_700_000_100_000,
			},
		]);
		const service = new EpubBookmarkService(app);

		const loaded = await service.loadBookmarksForBook(makeBook());
		expect(loaded).toHaveLength(2);
		const withNotes = loaded.find((b) => b.id === "bm-1") ?? null;
		expect(withNotes).not.toBeNull();
		expect(withNotes?.notes?.[0]?.id).toBe("bn-new");
		const plain = loaded.find((b) => b.id === "bm-2") ?? null;
		expect(plain?.notes ?? []).toEqual([]);
	});

	it("deleting a bookmark removes its notes with it", async () => {
		const { app, files } = createApp();
		seedAggregate(files);
		const service = new EpubBookmarkService(app);
		const created = await service.addBookmark(makeBook(), {
			cfi: "epubcfi(/6/4!/4/2/1:0)",
			chapterIndex: 2,
			percent: 45,
			chapterTitle: "第三章",
			createdAt: 1_700_000_000_000,
		});
		await service.addBookmarkNote(makeBook(), created.bookmark.id, "随书签一起走");

		const deleted = await service.deleteBookmark(makeBook(), created.bookmark.id);
		expect(deleted).toBe(true);
		expect(await service.loadBookmarksForBook(makeBook())).toHaveLength(0);

		await flushStore(app);
		expect(readPersistedBookmarks(files)).toHaveLength(0);
	});
});
