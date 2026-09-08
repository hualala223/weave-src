import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWeaveDataFilePath } from "../../../config/paths";
import {
	normalizeEpubStoredFontMarks,
	type EpubStoredFontMark,
} from "../schema-v2";
import {
	SCHEMA_V2_PERSIST_DELAY_MS,
	getSchemaV2Store,
} from "../schema-v2-store";
import { EpubStorageService } from "../EpubStorageService";

const DATA_PATH = "CONFIG/STORAGE";
const WEAVE_DATA_FILE = resolveWeaveDataFilePath(DATA_PATH);

function createMemoryAdapter(initialFiles: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		read: vi.fn(async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`File not found: ${path}`);
			return value;
		}),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
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
	return { adapter, files };
}

/** 最小 app 桩：与 schema-v2-store.test / EpubStorageService.test 的内存适配器同型。 */
function createApp(initialFiles: Record<string, string> = {}) {
	const { adapter, files } = createMemoryAdapter(initialFiles);
	const app = new App();
	(app as any).vault = {
		adapter,
		configDir: ".obsidian",
		getAbstractFileByPath: vi.fn(() => null),
		getFiles: vi.fn(() => []),
	};
	(app as any).plugins = {
		getPlugin: vi.fn(() => ({
			settings: { weaveParentFolder: "", dataPath: DATA_PATH },
		})),
	};
	return { app, files };
}

function upsertBookAggregate(app: App, id: string): void {
	const now = 1_700_000_000_000;
	getSchemaV2Store(app, () => DATA_PATH).upsertBook({
		id,
		file: { vaultPath: `Books/${id}.epub` },
		meta: { title: id, author: "Author", chapterCount: 1 },
		reading: {
			position: { chapterIndex: 0, cfi: "", percent: 0 },
			stats: { totalReadTime: 0, lastReadTime: now, createdTime: now },
		},
		notes: {
			bookmarks: [],
			highlights: [
				{
					id: "hl-001",
					cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:5)",
					color: "yellow",
					text: "既有划线",
					chapterIndex: 0,
					createdTime: now,
				},
			],
			excerpts: [],
		},
		audit: { createdAt: now, updatedAt: now },
	});
}

function buildFullMark(overrides: Partial<EpubStoredFontMark> = {}): EpubStoredFontMark {
	return {
		id: "fm-001",
		cfiRange: "epubcfi(/6/4!/4/2,/1:3,/1:6)",
		color: "gold",
		text: "重点",
		createdTime: 1_700_000_000_100,
		...overrides,
	};
}

describe("normalizeEpubStoredFontMarks（字色标记持久化兜底纯函数）", () => {
	it("保留字段完整的合法标记（roundtrip 形状）", () => {
		const mark = buildFullMark();
		expect(normalizeEpubStoredFontMarks([mark])).toEqual([mark]);
	});

	it("可选字段缺失时输出缺省形状（不产生 undefined 键以外的额外字段）", () => {
		expect(normalizeEpubStoredFontMarks([
			{ cfiRange: "epubcfi(/6/4)", color: "blue" },
		])).toEqual([{ cfiRange: "epubcfi(/6/4)", color: "blue" }]);
	});

	it("丢弃没有 cfiRange 的项（对齐 saveInlineHighlights 的兜底行为）", () => {
		const good = buildFullMark();
		const result = normalizeEpubStoredFontMarks([
			good,
			{ color: "red", text: "无定位" },
			{ cfiRange: "", color: "red" },
			{ cfiRange: "   ", color: "red" },
			{ cfiRange: 42, color: "red" },
		]);
		expect(result).toEqual([good]);
	});

	it("丢弃颜色 token 非法的项并裁剪 cfiRange 首尾空白", () => {
		const result = normalizeEpubStoredFontMarks([
			{ cfiRange: "  epubcfi(/6/8)  ", color: "yellow" },
			{ cfiRange: "epubcfi(/6/10)", color: 42 },
			{ cfiRange: "epubcfi(/6/12)", color: "purple" },
		]);
		expect(result).toEqual([{ cfiRange: "epubcfi(/6/12)", color: "purple" }]);
	});

	it("非数组输入返回空数组；数组内非对象项丢弃", () => {
		expect(normalizeEpubStoredFontMarks(null)).toEqual([]);
		expect(normalizeEpubStoredFontMarks(undefined)).toEqual([]);
		expect(normalizeEpubStoredFontMarks("fontMarks")).toEqual([]);
		expect(normalizeEpubStoredFontMarks({ cfiRange: "x" })).toEqual([]);
		expect(normalizeEpubStoredFontMarks([null, 42, "x", buildFullMark()])).toEqual([
			buildFullMark(),
		]);
	});

	it("可选字段类型非法时归一为 undefined，不影响整条记录保留", () => {
		const result = normalizeEpubStoredFontMarks([
			{
				cfiRange: "epubcfi(/6/4)",
				color: "green",
				id: 99,
				text: 123,
				createdTime: Number.NaN,
				extra: "未知字段剔除",
			},
		]);
		expect(result).toEqual([{ cfiRange: "epubcfi(/6/4)", color: "green" }]);
	});

	it("before/after 消歧 hint：字符串保留、非法类型归一为 undefined、旧记录无字段不受影响", () => {
		const hinted = normalizeEpubStoredFontMarks([
			{
				cfiRange: "epubcfi(/6/4)",
				color: "red",
				text: "同意",
				before: "第二个",
				after: "在那里",
			},
		]);
		expect(hinted).toEqual([
			{ cfiRange: "epubcfi(/6/4)", color: "red", text: "同意", before: "第二个", after: "在那里" },
		]);
		const badTypes = normalizeEpubStoredFontMarks([
			{ cfiRange: "epubcfi(/6/4)", color: "red", before: 42, after: {} },
		]);
		expect(badTypes).toEqual([{ cfiRange: "epubcfi(/6/4)", color: "red" }]);
		expect(normalizeEpubStoredFontMarks([{ cfiRange: "epubcfi(/6/4)", color: "red" }])).toEqual([
			{ cfiRange: "epubcfi(/6/4)", color: "red" },
		]);
	});
});

describe("EpubStorageService 字色标记存储回路（缝 2）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function flushStore(app: App): Promise<void> {
		await getSchemaV2Store(app, () => DATA_PATH).flush();
	}

	it("save→load roundtrip 后字段完整，且原样透传落盘 weave-data.json", async () => {
		const { app, files } = createApp();
		upsertBookAggregate(app, "bk_fm");
		await flushStore(app);

		const service = new EpubStorageService(app as any);
		const marks = [
			buildFullMark(),
			buildFullMark({ id: "fm-002", cfiRange: "epubcfi(/6/6!/4/4,/1:0,/1:2)", color: "blue" }),
		];
		await service.saveBookFontMarks("bk_fm", marks);

		// 节流窗口内读回：内存聚合即已生效
		expect(await service.loadBookFontMarks("bk_fm")).toEqual(marks);

		await flushStore(app);
		const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) as string);
		expect(parsed.books.bk_fm.notes.fontMarks).toEqual(marks);
		// 与划线数组并列共存、互不覆盖
		expect(parsed.books.bk_fm.notes.highlights).toHaveLength(1);
	});

	it("未保存过时读取返回空数组（缺省）", async () => {
		const { app } = createApp();
		upsertBookAggregate(app, "bk_fm");

		const service = new EpubStorageService(app as any);
		expect(await service.loadBookFontMarks("bk_fm")).toEqual([]);
	});

	it("保存前做坏数据兜底：无 cfiRange / 非法颜色的项被丢弃后落盘", async () => {
		const { app, files } = createApp();
		upsertBookAggregate(app, "bk_fm");
		await flushStore(app);

		const service = new EpubStorageService(app as any);
		await service.saveBookFontMarks("bk_fm", [
			buildFullMark(),
			{ color: "red", text: "坏数据" } as unknown as EpubStoredFontMark,
			{ cfiRange: "", color: "red" } as unknown as EpubStoredFontMark,
		]);

		const loaded = await service.loadBookFontMarks("bk_fm");
		expect(loaded).toEqual([buildFullMark()]);
		await flushStore(app);
		const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) as string);
		expect(parsed.books.bk_fm.notes.fontMarks).toEqual([buildFullMark()]);
	});

	it("磁盘上的坏 fontMarks 在读取侧同样被兜底清洗", async () => {
		const { app } = createApp({
			[WEAVE_DATA_FILE]: JSON.stringify({
				schemaVersion: 2,
				books: {
					bk_fm: {
						id: "bk_fm",
						file: { vaultPath: "Books/bk_fm.epub" },
						meta: { title: "bk_fm", chapterCount: 1 },
						reading: {
							position: { chapterIndex: 0, cfi: "", percent: 0 },
							stats: { totalReadTime: 0, lastReadTime: 0, createdTime: 0 },
						},
						notes: {
							bookmarks: [],
							highlights: [],
							excerpts: [],
							fontMarks: [
								null,
								{ cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:3)", color: "red", text: "好数据" },
								{ color: "red" },
								"垃圾字符串",
							],
						},
						audit: { createdAt: 0, updatedAt: 0 },
					},
				},
			}),
		});

		const service = new EpubStorageService(app as any);
		expect(await service.loadBookFontMarks("bk_fm")).toEqual([
			{ cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:3)", color: "red", text: "好数据" },
		]);
	});

	it("保存字色标记不影响同一本书的划线记录（notes 子域互不覆盖）", async () => {
		const { app } = createApp();
		upsertBookAggregate(app, "bk_fm");
		await flushStore(app);

		const service = new EpubStorageService(app as any);
		await service.saveBookFontMarks("bk_fm", [buildFullMark()]);

		const highlights = await service.loadBookHighlights("bk_fm");
		expect(highlights).toHaveLength(1);
		expect(highlights[0]?.text).toBe("既有划线");
	});

	it("书不存在时保存被忽略、读取返回空数组", async () => {
		const { app } = createApp();
		const service = new EpubStorageService(app as any);
		await expect(
			service.saveBookFontMarks("missing", [buildFullMark()])
		).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(SCHEMA_V2_PERSIST_DELAY_MS + 50);
		expect(await service.loadBookFontMarks("missing")).toEqual([]);
	});
});
