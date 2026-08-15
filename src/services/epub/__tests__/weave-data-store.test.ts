import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "obsidian";
import {
	WEAVE_DATA_SCHEMA_VERSION,
	WeaveDataStore,
	getWeaveDataStore,
} from "../weave-data-store";
import {
	normalizeDataPath,
	resolveDataCacheDir,
	resolveDataPath,
	resolveWeaveDataFilePath,
} from "../../../config/paths";

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

describe("weave-data-store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves data path helpers with default CONFIG/STORAGE", () => {
		expect(resolveDataPath(undefined)).toBe("CONFIG/STORAGE");
		expect(resolveDataPath("")).toBe("CONFIG/STORAGE");
		expect(resolveDataPath("Custom/Path")).toBe("Custom/Path");
		expect(normalizeDataPath("  ")).toBe("CONFIG/STORAGE");
		expect(resolveWeaveDataFilePath(undefined)).toBe("CONFIG/STORAGE/weave-data.json");
		expect(resolveWeaveDataFilePath("A/B")).toBe("A/B/weave-data.json");
		expect(resolveDataCacheDir("A/B")).toBe("A/B/cache");
	});

	it("writes document to <dataPath>/weave-data.json with schema version", async () => {
		const { app, files } = createApp();
		const store = new WeaveDataStore(app, () => DATA_PATH);

		store.updateSection("bookmarks", { "book.epub": { chapter: 1 } });
		await store.flush();

		const filePath = "CONFIG/STORAGE/weave-data.json";
		expect(files.has(filePath)).toBe(true);
		const parsed = JSON.parse(files.get(filePath) as string);
		expect(parsed.schemaVersion).toBe(WEAVE_DATA_SCHEMA_VERSION);
		expect(parsed.bookmarks).toEqual({ "book.epub": { chapter: 1 } });
	});

	it("writes atomically via temp file + rename", async () => {
		const { app, writes } = createApp();
		const store = new WeaveDataStore(app, () => DATA_PATH);

		store.updateSection("progress", {});
		await store.flush();

		expect(writes).toContain("CONFIG/STORAGE/weave-data.json.tmp");
		expect(writes).not.toContain("CONFIG/STORAGE/weave-data.json");
	});

	it("throttles persist and coalesces mutations", async () => {
		const { app, files, writes } = createApp();
		const store = new WeaveDataStore(app, () => DATA_PATH);

		store.updateSection("progress", { a: 1 });
		store.updateSection("progress", { a: 2 });
		store.updateSection("shelf", { books: [] });

		// 未到节流窗口：不应写盘
		expect(writes.length).toBe(0);

		await vi.advanceTimersByTimeAsync(500);
		expect(writes.length).toBeGreaterThan(0);

		const parsed = JSON.parse(files.get("CONFIG/STORAGE/weave-data.json") as string) as {
			progress: { a: number };
			shelf: { books: unknown[] };
		};
		expect(parsed.progress).toEqual({ a: 2 });
		expect(parsed.shelf).toEqual({ books: [] });
	});

	it("reads back persisted document on a fresh store", async () => {
		const { app, files } = createApp();
		const store = new WeaveDataStore(app, () => DATA_PATH);
		store.updateSection("traceability", { refs: ["r1"] });
		await store.flush();

		const store2 = new WeaveDataStore(app, () => DATA_PATH);
		const document = await store2.getDocument();
		expect(document.traceability).toEqual({ refs: ["r1"] });
		expect(document.schemaVersion).toBe(WEAVE_DATA_SCHEMA_VERSION);
	});

	it("tolerates missing file and corrupt JSON", async () => {
		const { app } = createApp();
		const store = new WeaveDataStore(app, () => DATA_PATH);
		const document = await store.getDocument();
		expect(document.schemaVersion).toBe(WEAVE_DATA_SCHEMA_VERSION);

		const { app: app2 } = createApp({ "CONFIG/STORAGE/weave-data.json": "{corrupt" });
		const store2 = new WeaveDataStore(app2, () => DATA_PATH);
		const loadPromise = store2.getDocument();
		// 重试延迟使用 window.setTimeout：推进假定时器触发重试
		await vi.advanceTimersByTimeAsync(300);
		const document2 = await loadPromise;
		expect(document2.schemaVersion).toBe(WEAVE_DATA_SCHEMA_VERSION);
	});

	it("preserves unknown top-level keys", async () => {
		const { app, files } = createApp({
			"CONFIG/STORAGE/weave-data.json": JSON.stringify({
				schemaVersion: WEAVE_DATA_SCHEMA_VERSION,
				unknownFutureKey: { x: 1 },
			}),
		});
		const store = new WeaveDataStore(app, () => DATA_PATH);
		const document = await store.getDocument();
		expect(document.unknownFutureKey).toEqual({ x: 1 });

		store.updateSection("highlights", {});
		await store.flush();
		const persisted = JSON.parse(files.get("CONFIG/STORAGE/weave-data.json") as string);
		expect(persisted.unknownFutureKey).toEqual({ x: 1 });
	});

	it("getWeaveDataStore returns singleton per app+path", () => {
		const { app } = createApp();
		const storeA = getWeaveDataStore(app, () => DATA_PATH);
		const storeB = getWeaveDataStore(app, () => DATA_PATH);
		const storeC = getWeaveDataStore(app, () => "OTHER/PATH");
		expect(storeA).toBe(storeB);
		expect(storeA).not.toBe(storeC);
		storeA.resetForTests();
	});
});