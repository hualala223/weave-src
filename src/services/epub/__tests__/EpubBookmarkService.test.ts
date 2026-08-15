import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";

const getCompatiblePlugin = vi.fn();
const loadExcerptSettings = vi.fn(async () => ({
	strikethroughDisplayMode: "strikethrough" as const,
	showStrikethroughInSidebar: false,
}));
const getEpubStorageService = vi.fn(() => ({ loadExcerptSettings }));

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("../../../tests/mocks/obsidian")>(
		"../../../tests/mocks/obsidian"
	);
	return actual;
});

vi.mock("../../../utils/plugin-access", () => ({
	getCompatiblePlugin,
}));

vi.mock("../epub-storage-access", () => ({
	getEpubStorageService,
}));

vi.mock("../epub-runtime", () => ({
	EPUB_RUNTIME: {
		pluginId: "weave-epub-reader",
		pluginDirName: "weave-epub-reader",
		viewTypes: {
			reader: "weave-epub-reader-standalone",
			sidebar: "weave-epub-sidebar-standalone",
			bookshelfSidebar: "weave-epub-bookshelf-sidebar-standalone",
		},
		protocol: {
			allNames: ["weave-epub-reader", "weave-epub"],
		},
		events: {
			bookshelfDataChanged: "test:bookshelf-data-changed",
			bookshelfRefreshRequest: "test:bookshelf-refresh-request",
			bookshelfDisplaySettingsChanged: "test:bookshelf-display-settings-changed",
			excerptSettingsChanged: "test:excerpt-settings-changed",
			navigate: "test:epub-navigate",
		},
		globals: {
			pendingNavigationKey: "__testPendingNav",
		},
	},
	getEpubRuntime: () => ({
		pluginId: "weave-epub-reader",
		pluginDirName: "weave-epub-reader",
		viewTypes: {
			reader: "weave-epub-reader-standalone",
			sidebar: "weave-epub-sidebar-standalone",
			bookshelfSidebar: "weave-epub-bookshelf-sidebar-standalone",
		},
		protocol: {
			allNames: ["weave-epub-reader", "weave-epub"],
		},
		events: {
			bookshelfDataChanged: "test:bookshelf-data-changed",
			bookshelfRefreshRequest: "test:bookshelf-refresh-request",
			bookshelfDisplaySettingsChanged: "test:bookshelf-display-settings-changed",
			excerptSettingsChanged: "test:excerpt-settings-changed",
			navigate: "test:epub-navigate",
		},
		globals: {
			pendingNavigationKey: "__testPendingNav",
		},
	}),
}));

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

async function flushStore(app: unknown) {
	const { getWeaveDataStore } = await import("../weave-data-store");
	await getWeaveDataStore(app as any, () => DATA_PATH).flush();
}

function readingStateInput() {
	const stats = {
		totalReadTime: 120_000,
		lastReadTime: 1_700_000_000_000,
		createdTime: 1_699_000_000_000,
		bookWpm: 280,
		paceSampleCount: 8,
	};
	return {
		currentPosition: { chapterIndex: 0, cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)", percent: 12 },
		readingStats: stats,
	};
}

describe("EpubBookmarkService", () => {
	beforeEach(() => {
		getCompatiblePlugin.mockReset();
		getCompatiblePlugin.mockReturnValue({ settings: {} });
		getEpubStorageService.mockClear();
		loadExcerptSettings.mockClear();
		loadExcerptSettings.mockResolvedValue({
			strikethroughDisplayMode: "strikethrough",
			showStrikethroughInSidebar: false,
		});
	});

	it("buildEpubBookmarkFileName uses data_ prefix without book ids", async () => {
		const { buildEpubBookmarkFileName, buildEpubBookmarkFileNameCandidates } = await import(
			"../EpubBookmarkService"
		);

		expect(buildEpubBookmarkFileName("百年孤独")).toBe("data_百年孤独.md");
		expect(
			buildEpubBookmarkFileNameCandidates({ title: "百年孤独", author: "马尔克斯" }).slice(0, 4)
		).toEqual([
			"data_百年孤独.md",
			"data_百年孤独 - 马尔克斯.md",
			"data_百年孤独 2.md",
			"data_百年孤独 3.md",
		]);
	});

	it("buildEpubBookmarkStableKey shortens fingerprints and lists legacy filename suffixes", async () => {
		const {
			buildEpubBookmarkStableKey,
			buildLegacyEpubBookmarkStableKeySuffixes,
		} = await import("../EpubBookmarkService");

		expect(
			buildEpubBookmarkStableKey({
				sourceFingerprint: "353ab0d0ca49b9a2d636e1b64e0e43cbbd42ed1869f5e9de2b84afb5",
			})
		).toBe("epubsrc-353ab0d0ca49");

		expect(
			buildLegacyEpubBookmarkStableKeySuffixes({
				sourceFingerprint: "353ab0d0ca49b9a2d636e1b64e0e43cbbd42ed1869f5e9de2b84afb5",
				canonicalStableKey: "epubsrc-353ab0d0ca49",
			})
		).toEqual([
			"--353ab0d0ca49b9a2d636e1b64e0e43cbbd42ed1869f5e9de2b84afb5.md",
		]);
	});

	it("builds a short bookmark stableKey from sourceFingerprint before sourceId", async () => {
		const { EpubBookmarkService, buildEpubBookmarkStableKey } = await import(
			"../EpubBookmarkService"
		);
		const service = new EpubBookmarkService({ plugins: { getPlugin: vi.fn(() => null) } } as any);

		const stableKey = (service as any).buildStableKey(makeBook());

		expect(stableKey).toBe(
			buildEpubBookmarkStableKey({
				sourceFingerprint: "4a9ad58db18a2176c9c0f",
			})
		);
		expect(stableKey).toBe("epubsrc-4a9ad58db18a");
		expect(stableKey).not.toContain("epubsrc-demo");
		expect(stableKey.length).toBeLessThan(24);
	});

	it("prefers the current runtime plugin settings when resolving bookmark folder", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const app = {
			plugins: {
				getPlugin: vi.fn((pluginId: string) =>
					pluginId === "fork-weave-epub-reader"
						? { settings: { bookmarkFolder: "Bookmarks/EPUB" } }
						: null
				),
			},
		} as any;

		const service = new EpubBookmarkService(app);

		expect(service.getBookmarkFolder()).toBe("Bookmarks/EPUB");
		expect(app.plugins.getPlugin).toHaveBeenCalledWith("fork-weave-epub-reader");
		expect(getCompatiblePlugin).not.toHaveBeenCalled();
	});

	it("falls back to a compatible plugin host when the runtime plugin is unavailable", async () => {
		const { EpubBookmarkService, DEFAULT_EPUB_BOOKMARK_FOLDER } = await import(
			"../EpubBookmarkService"
		);
		getCompatiblePlugin.mockReturnValue({
			settings: {
				bookmarkFolder: "Shared/Bookmarks",
			},
		});
		const app = {
			plugins: {
				getPlugin: vi.fn(() => null),
			},
		} as any;

		const service = new EpubBookmarkService(app);

		expect(service.getBookmarkFolder()).toBe("Shared/Bookmarks");
		expect(getCompatiblePlugin).toHaveBeenCalledWith(app);

		getCompatiblePlugin.mockReturnValue({ settings: {} });
		expect(new EpubBookmarkService(app).getBookmarkFolder()).toBe(DEFAULT_EPUB_BOOKMARK_FOLDER);
	});

	it("adds a bookmark, persists it into weave-data.json and loads it back by book path", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app, files } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();

		const result = await service.addBookmark(book, {
			cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
			chapterIndex: 0,
			percent: 5,
			chapterTitle: "第一章",
			preview: "第一章",
		});

		expect(result.created).toBe(true);
		expect(result.bookmark.cfi).toBe("epubcfi(/6/2!/4/2,/1:0,/1:4)");
		expect(result.filePath).toBe("Books/demo.epub");

		const loaded = await service.loadBookmarksForBook(book);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].id).toBe(result.bookmark.id);

		// Ensure the record landed in weave-data.json on the normalized book path key.
		await flushStore(app);
		expect(files.has(DATA_FILE)).toBe(true);
		const parsed = JSON.parse(files.get(DATA_FILE) as string);
		expect(parsed.schemaVersion).toBe(1);
		expect(Object.keys(parsed.bookmarks)).toEqual(["Books/demo.epub"]);
		expect(parsed.bookmarks["Books/demo.epub"].bookmarks).toHaveLength(1);
	});

	it("dedupes bookmarks by normalized cfi and reports created=false", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();
		const input = {
			cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
			chapterIndex: 0,
			percent: 5,
			chapterTitle: "第一章",
		};

		const first = await service.addBookmark(book, input);
		const second = await service.addBookmark(book, {
			...input,
			chapterIndex: 1,
			percent: 6,
			chapterTitle: "第二章",
		});

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.bookmark.id).toBe(first.bookmark.id);
		expect(second.bookmark.createdAt).toBe(first.bookmark.createdAt);
		const loaded = await service.loadBookmarksForBook(book);
		expect(loaded).toHaveLength(1);
	});

	it("deletes a bookmark by id", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app, files } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();

		const first = await service.addBookmark(book, {
			cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
			chapterIndex: 0,
			percent: 5,
			chapterTitle: "第一章",
		});
		await service.addBookmark(book, {
			cfi: "epubcfi(/6/2!/4/2,/2:0,/2:4)",
			chapterIndex: 1,
			percent: 8,
			chapterTitle: "第二章",
		});

		const deleted = await service.deleteBookmark(book, first.bookmark.id);
		expect(deleted).toBe(true);

		const remaining = await service.loadBookmarksForBook(book);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).not.toBe(first.bookmark.id);

		await flushStore(app);
		const parsed = JSON.parse(files.get(DATA_FILE) as string);
		expect(parsed.bookmarks["Books/demo.epub"].bookmarks).toHaveLength(1);
	});

	it("writes and reads readingState", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();
		const state = readingStateInput();

		const returnedPath = await service.writeReadingState(book, state);
		expect(returnedPath).toBe("Books/demo.epub");

		const readState = await service.readReadingState(book);
		expect(readState).not.toBeNull();
		expect(readState?.currentPosition.cfi).toBe("epubcfi(/6/2!/4/2,/1:0,/1:4)");
		expect(readState?.currentPosition.percent).toBe(12);

		const byPathState = await service.readReadingStateByBookPath("Books/demo.epub");
		expect(byPathState?.currentPosition.percent).toBe(12);
	});

	it("finds a bookmark snapshot by book path", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();

		await service.addBookmark(book, {
			cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
			chapterIndex: 0,
			percent: 5,
			chapterTitle: "第一章",
		});

		const snapshot = await service.findBookmarkSnapshotByBookPath("Books/demo.epub");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.bookPath).toBe("Books/demo.epub");
		expect(snapshot?.bookmarks).toHaveLength(1);

		expect(await service.findBookmarkSnapshotByBookPath("Books/missing.epub")).toBeNull();
	});

	it("syncs analytics in a non-empty way and returns the book path", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();

		const filePath = await service.syncAnalytics(book, []);
		expect(filePath).toBe("Books/demo.epub");

		const snapshot = await service.findBookmarkSnapshotByBookPath("Books/demo.epub");
		expect(snapshot?.analytics).toBeDefined();
	});

	it("migrates book file references in the store", async () => {
		const { EpubBookmarkService } = await import("../EpubBookmarkService");
		const { app, files } = createApp();
		const service = new EpubBookmarkService(app);
		const book = makeBook();

		await service.addBookmark(book, {
			cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
			chapterIndex: 0,
			percent: 5,
			chapterTitle: "第一章",
		});

		await flushStore(app);
		const updated = await service.updateBookFileReferences(
			"Books/demo.epub",
			"Books/renamed.epub"
		);
		expect(updated).toBe(1);

		// The record is keyed by the new path and its bookPath reflects the rename.
		expect(await service.readBookmarkSnapshotForBook({ ...book, filePath: "Books/renamed.epub" }))
			.not.toBeNull();
		expect(await service.readBookmarkSnapshotForBook(book)).toBeNull();

		await flushStore(app);
		const parsed = JSON.parse(files.get(DATA_FILE) as string);
		expect(Object.keys(parsed.bookmarks)).toEqual(["Books/renamed.epub"]);
		expect(parsed.bookmarks["Books/renamed.epub"].bookPath).toBe("Books/renamed.epub");
	});
});
