import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWeaveDataFilePath } from "../../../config/paths";
import {
	type EpubBookAggregate,
	WEAVE_DATA_SCHEMA_VERSION,
} from "../schema-v2";
import {
	SCHEMA_V2_PERSIST_DELAY_MS,
	SchemaV2Store,
	getSchemaV2Store,
} from "../schema-v2-store";

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
	(app as any).vault = { adapter };
	return { app, files, writes };
}

const DATA_PATH = "CONFIG/STORAGE";
const FILE_PATH = resolveWeaveDataFilePath(DATA_PATH);

function createAggregate(id: string, title: string): EpubBookAggregate {
	const now = 1_700_000_000_000;
	return {
		id,
		file: { vaultPath: `Books/${title}.epub`, sourceFingerprint: `fp-${id}` },
		meta: { title, author: "Author", chapterCount: 1 },
		reading: {
			position: { chapterIndex: 0, cfi: "", percent: 0 },
			stats: { totalReadTime: 0, lastReadTime: 0, createdTime: now },
		},
		notes: { bookmarks: [], highlights: [], excerpts: [] },
		audit: { createdAt: now, updatedAt: now },
	};
}

describe("schema-v2-store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists document to <dataPath>/weave-data.json with schemaVersion=2", async () => {
		const { app, files } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "设计中的设计"));
		await store.flush();

		expect(files.has(FILE_PATH)).toBe(true);
		const parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.schemaVersion).toBe(WEAVE_DATA_SCHEMA_VERSION);
		expect(parsed.books.bk_001.meta.title).toBe("设计中的设计");
		expect(typeof parsed.updatedAt).toBe("number");
	});

	it("never persists meta.coverImage into weave-data.json (covers resolve dynamically)", async () => {
		const { app, files } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		const aggregate = createAggregate("bk_001", "Book");
		store.upsertBook({
			...aggregate,
			meta: {
				...aggregate.meta,
				coverImage: "data:image/jpeg;base64,s0m3R3411yV3rYl0nGc0v3r==",
			},
		});
		await store.flush();

		const parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.books.bk_001.meta.coverImage).toBeUndefined();
		expect(parsed.books.bk_001.meta.title).toBe("Book");
	});

	it("writes atomically via temp file + rename", async () => {
		const { app, writes } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "Book"));
		await store.flush();

		expect(writes).toContain(`${FILE_PATH}.tmp`);
		expect(writes).not.toContain(FILE_PATH);
	});

	it("reads back persisted books on a fresh store", async () => {
		const { app } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "Book A"));
		store.upsertBook(createAggregate("bk_002", "Book B"));
		await store.flush();

		const store2 = new SchemaV2Store(app, () => DATA_PATH);
		const books = await store2.getBooks();
		expect(books.map((book) => book.id).sort()).toEqual(["bk_001", "bk_002"]);
		const book = await store2.getBook("bk_001");
		expect(book?.file.vaultPath).toBe("Books/Book A.epub");
		expect(await store2.getBook("missing")).toBeUndefined();
	});

	it("upsertBook preserves original createdAt and refreshes updatedAt", async () => {
		const { app } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		const aggregate = createAggregate("bk_001", "Book");
		store.upsertBook(aggregate);
		await store.flush();

		store.upsertBook({
			...createAggregate("bk_001", "Book"),
			meta: { ...aggregate.meta, title: "Renamed" },
		});
		await store.flush();

		const book = await store.getBook("bk_001");
		expect(book?.meta.title).toBe("Renamed");
		expect(book?.audit.createdAt).toBe(aggregate.audit.createdAt);
	});

	it("saveBookNotes / saveReading update only the target book subdomain", async () => {
		const { app } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "Book"));
		store.saveBookNotes("bk_001", {
			bookmarks: [
				{
					id: "bm_1",
					cfi: "epubcfi(/6/4)",
					chapterIndex: 1,
					percent: 0.5,
					chapterTitle: "Ch1",
					createdAt: 1,
				},
			],
			highlights: [],
			excerpts: [],
		});
		store.saveReading("bk_001", {
			position: { chapterIndex: 2, cfi: "epubcfi(/6/8)", percent: 0.9 },
			stats: { totalReadTime: 100, lastReadTime: 2, createdTime: 1 },
		});
		await store.flush();

		const book = await store.getBook("bk_001");
		expect(book?.notes.bookmarks).toHaveLength(1);
		expect(book?.notes.excerpts).toEqual([]);
		expect(book?.reading.position.cfi).toBe("epubcfi(/6/8)");
		expect(book?.reading.stats.totalReadTime).toBe(100);
	});

	it("saveBookNotes / saveReading ignore unknown book ids", async () => {
		const { app } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.saveBookNotes("missing", {
			bookmarks: [],
			highlights: [],
			excerpts: [],
		});
		store.saveReading("missing", {
			position: { chapterIndex: 0, cfi: "epubcfi(/6)", percent: 0 },
			stats: { totalReadTime: 0, lastReadTime: 0, createdTime: 0 },
		});
		await store.flush();

		expect(await store.getBook("missing")).toBeUndefined();
	});

	it("saveSettings writes top-level settings and null deletes keys", async () => {
		const { app, files } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.saveSettings({
			readerSettings: {
				lineHeight: 1.6,
				letterSpacing: 0,
				pageMargin: 24,
				viewportSidePadding: 12,
				widthMode: "standard",
				layoutMode: "paginated",
				flowMode: "paginated",
				showScrolledSideNav: true,
				showMobilePageArrows: true,
				mobilePageArrowPosition: null,
				footnoteClickAction: "preview",
				showTopSticker: true,
				topStickerLayout: "auto",
			},
			uiMemory: { selectionQuickCreateLastFolder: "阅读摘录" },
			shelfDisplayMode: "grid",
			playlists: [{ id: "pl_01", name: "设计书单", bookIds: ["bk_001"] }],
		});
		await store.flush();

		let parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.shelfDisplayMode).toBe("grid");
		expect(parsed.uiMemory.selectionQuickCreateLastFolder).toBe("阅读摘录");
		expect(parsed.playlists).toHaveLength(1);
		expect(parsed.readerSettings.lineHeight).toBe(1.6);
		expect(parsed.readerSettings.paragraphModeEnabled).toBeUndefined();

		store.saveSettings({ playlists: null, shelfDisplayMode: null });
		await store.flush();

		parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.playlists).toBeUndefined();
		expect(parsed.shelfDisplayMode).toBeUndefined();
		expect(parsed.readerSettings).toBeDefined();
	});

	it("preserves non-owned top-level keys written by other stores (v1 coexist)", async () => {
		const { app, files } = createApp({
			[FILE_PATH]: JSON.stringify({
				schemaVersion: 1,
				shelf: { scanIndex: [{ path: "Books/a.epub" }] },
				traceability: { sourceRegistry: [] },
			}),
		});
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "Book"));
		await store.flush();

		const parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.shelf).toEqual({ scanIndex: [{ path: "Books/a.epub" }] });
		expect(parsed.traceability).toEqual({ sourceRegistry: [] });
		expect(parsed.books.bk_001).toBeDefined();
		expect(parsed.schemaVersion).toBe(2);
	});

	it("throttles persist and coalesces mutations", async () => {
		const { app, files, writes } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "A"));
		store.upsertBook(createAggregate("bk_001", "B"));

		// 未到节流窗口：不应写盘
		expect(writes.length).toBe(0);

		await vi.advanceTimersByTimeAsync(SCHEMA_V2_PERSIST_DELAY_MS + 100);
		expect(writes.length).toBeGreaterThan(0);

		const parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.books.bk_001.meta.title).toBe("B");
	});

	it("getSchemaV2Store returns singleton per app+path", () => {
		const { app } = createApp();
		const storeA = getSchemaV2Store(app, () => DATA_PATH);
		const storeB = getSchemaV2Store(app, () => DATA_PATH);
		const storeC = getSchemaV2Store(app, () => "OTHER/PATH");
		expect(storeA).toBe(storeB);
		expect(storeA).not.toBe(storeC);
		storeA.resetForTests();
	});

	it("highlight pastedAt round-trips through saveBookNotes (已粘贴标记向后兼容)", async () => {
		const { app, files } = createApp();
		const store = new SchemaV2Store(app, () => DATA_PATH);

		store.upsertBook(createAggregate("bk_001", "Book"));
		store.saveBookNotes("bk_001", {
			bookmarks: [],
			highlights: [
				{
					id: "hl_1",
					text: "已粘贴的划线",
					color: "yellow",
					chapterIndex: 0,
					cfiRange: "epubcfi(/6/4)",
					createdTime: 1_700_000_000_000,
					pastedAt: 1_790_000_000_000,
				},
				{
					// 旧记录：无 pastedAt 字段 = 未粘贴，读取原样保留
					id: "hl_2",
					text: "旧划线",
					color: "green",
					chapterIndex: 1,
					cfiRange: "epubcfi(/6/8)",
					createdTime: 1_700_000_100_000,
				},
			],
			excerpts: [],
		});
		await store.flush();

		// 落盘 JSON：pastedAt 原样序列化，旧记录不带该字段
		const parsed = JSON.parse(files.get(FILE_PATH) as string);
		expect(parsed.books.bk_001.notes.highlights[0].pastedAt).toBe(1_790_000_000_000);
		expect(parsed.books.bk_001.notes.highlights[1].pastedAt).toBeUndefined();

		// 重读：字段保留（旧记录缺省视为未粘贴）
		const store2 = new SchemaV2Store(app, () => DATA_PATH);
		const book = await store2.getBook("bk_001");
		expect(book?.notes.highlights[0].pastedAt).toBe(1_790_000_000_000);
		expect(book?.notes.highlights[1].pastedAt).toBeUndefined();
		store2.resetForTests();
	});
});
