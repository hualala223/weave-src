/**
 * Schema v2 数据存储核心（weave-data.json 单一数据文件，schemaVersion=2）
 *
 * 设计（对照 schema-v2.ts 的类型定义）：
 * - 唯一数据文件：<dataPath>/weave-data.json
 * - 书是聚合根：books[bookId] = EpubBookAggregate（元数据/阅读状态/书签/高亮/摘录/每书 UI）
 * - 不做旧数据兼容与迁移：schema v2 起以本结构为唯一权威
 * - 写盘做整书 apply：持久化前重新读取磁盘整个 doc → 应用 books[id]/顶层键变更 → 原子写，
 *   简化并发（无需逐分区锁）
 * - 原子写：临时文件 + rename（复用 writeUnifiedLocalDataAtomically）
 * - 节流落盘：mutate 后延迟合并写盘；flush() 立即写盘
 * - 与 v1（WeaveDataStore）并存过渡期间：仅覆盖本 store 拥有的顶层键，
 *   保留磁盘上的其他顶层键（v1 分区 / 未知键），避免互相覆盖
 *
 * @module services/epub/schema-v2-store
 */
import type { App } from "obsidian";
import { normalizeDataPath, resolveWeaveDataFilePath } from "../../config/paths";
import { DirectoryUtils } from "../../utils/directory-utils";
import { logger } from "../../utils/logger";
import { perfBegin, perfEnd } from "../../utils/perf-probe";
import {
	readWithTransientParseRetry,
	writeUnifiedLocalDataAtomically,
} from "./epub-unified-local-data-store";
import {
	WEAVE_DATA_SCHEMA_VERSION,
	type EpubBookAggregate,
	type EpubBookNotes,
	type EpubBookReading,
	type EpubPlaylist,
	type EpubReaderSettingsV2,
	type EpubStoredHighlight,
	type WeaveDataDocumentV2,
	type WeaveUiMemory,
} from "./schema-v2";

export type {
	EpubBookAggregate,
	EpubBookNotes,
	EpubBookReading,
	EpubPlaylist,
	EpubReaderSettingsV2,
	EpubStoredHighlight,
	WeaveDataDocumentV2,
	WeaveUiMemory,
} from "./schema-v2";

/** 默认落盘节流延迟。 */
export const SCHEMA_V2_PERSIST_DELAY_MS = 400;

const EMPTY_DOCUMENT: WeaveDataDocumentV2 = {
	schemaVersion: WEAVE_DATA_SCHEMA_VERSION,
};

/** SchemaV2Store 负责持久化的顶层键（其余顶层键以磁盘为准保留）。 */
const OWNED_TOP_LEVEL_KEYS = new Set<string>([
	"schemaVersion",
	"updatedAt",
	"uiMemory",
	"readerSettings",
	"shelfDisplayMode",
	"playlists",
	"books",
	"vaultLocalStorage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 持久化前剔除书籍元数据中的封面图（coverImage 可能是很大的 base64 data URL）。
 * 封面改为由运行时动态解析（书架懒加载），不入 weave-data.json。
 */
function stripPersistedBookMetadataCover(
	meta: EpubBookAggregate["meta"]
): EpubBookAggregate["meta"] {
	const { coverImage: _coverImage, ...rest } = meta;
	return rest;
}

/** 单例 store 缓存（按 App + 数据路径）。 */
const storeByApp = new WeakMap<App, Map<string, SchemaV2Store>>();

export function getSchemaV2Store(
	app: App,
	getDataPath: () => string
): SchemaV2Store {
	let stores = storeByApp.get(app);
	if (!stores) {
		stores = new Map<string, SchemaV2Store>();
		storeByApp.set(app, stores);
	}
	const dataPath = normalizeDataPath(getDataPath());
	let store = stores.get(dataPath);
	if (!store) {
		store = new SchemaV2Store(app, getDataPath);
		stores.set(dataPath, store);
	}
	return store;
}

/** 顶层设置补丁：undefined = 保持原值；null = 删除该键。 */
export interface SchemaV2SettingsPatch {
	readerSettings?: EpubReaderSettingsV2 | null;
	uiMemory?: WeaveUiMemory | null;
	shelfDisplayMode?: string | null;
	playlists?: EpubPlaylist[] | null;
}

export class SchemaV2Store {
	private document: WeaveDataDocumentV2 | null = null;
	private loadPromise: Promise<WeaveDataDocumentV2> | null = null;
	private persistTimer: number | null = null;
	private persistPromise: Promise<void> = Promise.resolve();
	private dirty = false;
	/** 已被显式删除的 owned 顶层键（持久化时从磁盘文档移除）。 */
	private deletedOwnedKeys = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly getDataPath: () => string
	) {}

	/** 数据文件路径（vault 相对）。 */
	getFilePath(): string {
		return resolveWeaveDataFilePath(this.getDataPath());
	}

	/** 数据目录（vault 相对）。 */
	getDataDir(): string {
		return normalizeDataPath(this.getDataPath());
	}

	/** 读取（惰性 + 内存缓存）整个文档。文件不存在/损坏时返回空文档。 */
	async getDocument(): Promise<WeaveDataDocumentV2> {
		if (this.document) {
			return this.document;
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadDocument();
		}
		return this.loadPromise;
	}

	/** 同步读取内存中的文档（未加载时返回空文档，不触发 IO）。 */
	getCachedDocument(): WeaveDataDocumentV2 {
		return this.document ? { ...this.document } : { ...EMPTY_DOCUMENT };
	}

	/** 全部书籍聚合（无书时为空数组）。 */
	async getBooks(): Promise<EpubBookAggregate[]> {
		const document = await this.getDocument();
		return Object.values(document.books ?? {});
	}

	/** 单本书聚合（不存在时 undefined）。 */
	async getBook(id: string): Promise<EpubBookAggregate | undefined> {
		const document = await this.getDocument();
		return document.books?.[id];
	}

	/** 整书写入 books[id]（创建或覆盖），audit 自动刷新；空 id 忽略。 */
	upsertBook(aggregate: EpubBookAggregate): void {
		const id = String(aggregate?.id || "").trim();
		if (!id) {
			return;
		}
		this.mutate((document) => {
			document.books ??= {};
			const now = Date.now();
			const previous = document.books[id];
			document.books[id] = {
				...aggregate,
				id,
				// 封面不入库：预览由运行时动态解析（meta 剔除 coverImage，避免 base64 撑爆数据文件）。
				meta: stripPersistedBookMetadataCover(aggregate.meta),
				audit: {
					createdAt:
						previous?.audit?.createdAt ?? aggregate.audit?.createdAt ?? now,
					updatedAt: now,
				},
			};
		});
	}

	/** 覆盖某书的 notes（书不存在时忽略）。 */
	saveBookNotes(id: string, notes: EpubBookNotes): void {
		this.mutateBook(id, (book) => {
			book.notes = notes;
		});
	}

	/** 覆盖某书的 reading（书不存在时忽略）。 */
	saveReading(id: string, reading: EpubBookReading): void {
		this.mutateBook(id, (book) => {
			book.reading = reading;
		});
	}

	/** 删除 books[id]（不存在时忽略）。 */
	removeBook(id: string): void {
		const normalizedId = String(id || "").trim();
		if (!normalizedId) {
			return;
		}
		this.mutate((document) => {
			if (document.books) {
				delete document.books[normalizedId];
			}
		});
	}

	/** 更新文档顶层设置（readerSettings/uiMemory/shelfDisplayMode/playlists）。 */
	saveSettings(patch: SchemaV2SettingsPatch): void {
		this.mutate((document) => {
			const apply = (
				key: "uiMemory" | "readerSettings" | "shelfDisplayMode" | "playlists",
				value: unknown
			) => {
				if (value === undefined) {
					return;
				}
				if (value === null) {
					delete document[key];
					this.deletedOwnedKeys.add(key);
				} else {
					(document as unknown as Record<string, unknown>)[key] = value;
					this.deletedOwnedKeys.delete(key);
				}
			};
			apply("uiMemory", patch.uiMemory);
			apply("readerSettings", patch.readerSettings);
			apply("shelfDisplayMode", patch.shelfDisplayMode);
			apply("playlists", patch.playlists);
		});
	}

	/** 立即落盘（等待进行中的写盘链完成）。 */
	async flush(): Promise<void> {
		if (this.persistTimer !== null) {
			window.clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.persistPending();
	}

	/** 测试辅助：重置单例状态。 */
	resetForTests(): void {
		if (this.persistTimer !== null) {
			window.clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.document = null;
		this.loadPromise = null;
		this.persistPromise = Promise.resolve();
		this.dirty = false;
		this.deletedOwnedKeys = new Set<string>();
	}

	private mutateBook(id: string, updater: (book: EpubBookAggregate) => void): void {
		const normalizedId = String(id || "").trim();
		if (!normalizedId) {
			return;
		}
		this.mutate((document) => {
			const book = document.books?.[normalizedId];
			if (!book) {
				return;
			}
			updater(book);
			book.audit = { ...book.audit, updatedAt: Date.now() };
		});
	}

	/** 内存中变更文档（同步），并调度节流落盘。 */
	mutate(mutator: (document: WeaveDataDocumentV2) => void): void {
		const document = this.getCachedDocument();
		mutator(document);
		document.updatedAt = Date.now();
		this.document = document;
		this.schedulePersist();
	}

	private async loadDocument(): Promise<WeaveDataDocumentV2> {
		const filePath = this.getFilePath();
		try {
			const adapter = this.app.vault.adapter;
			const parsed = await readWithTransientParseRetry(async () => {
				if (!(await adapter.exists(filePath))) {
					return null;
				}
				const raw = await adapter.read(filePath);
				return raw?.trim() ? (JSON.parse(raw) as unknown) : null;
			});
			if (parsed && isRecord(parsed)) {
				this.document = {
					...(parsed as Partial<WeaveDataDocumentV2>),
					schemaVersion: WEAVE_DATA_SCHEMA_VERSION,
				} as WeaveDataDocumentV2;
				return this.document;
			}
		} catch (error) {
			logger.warn(`[SchemaV2Store] 读取失败: ${filePath}`, error);
		}
		this.document = { ...EMPTY_DOCUMENT };
		return this.document;
	}

	private schedulePersist(): void {
		this.dirty = true;
		if (this.persistTimer !== null) {
			return;
		}
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null;
			void this.persistPending();
		}, SCHEMA_V2_PERSIST_DELAY_MS);
	}

	private async persistPending(): Promise<void> {
		if (!this.dirty && !this.document) {
			await this.persistPromise;
			return;
		}
		const persistProbeStart = perfBegin();
		const snapshot = await this.buildPersistSnapshot();
		perfEnd("persist.buildSnapshot", persistProbeStart, { always: true });
		this.dirty = false;

		this.persistPromise = this.persistPromise.then(async () => {
			try {
				const adapter = this.app.vault.adapter;
				const filePath = this.getFilePath();
				await DirectoryUtils.ensureDirForFile(adapter, filePath);
				const stringifyProbeStart = perfBegin();
				const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
				perfEnd("persist.stringify", stringifyProbeStart, {
					always: true,
					extra: { bytes: serialized.length },
				});
				const writeProbeStart = perfBegin();
				await writeUnifiedLocalDataAtomically(adapter, filePath, serialized);
				perfEnd("persist.writeFile", writeProbeStart, { always: true });
			} catch (error) {
				logger.warn(`[SchemaV2Store] 写入失败: ${this.getFilePath()}`, error);
				this.dirty = true;
			}
		});

		await this.persistPromise;
		perfEnd("persist.total", persistProbeStart, { always: true });
	}

	/**
	 * 整书 apply：以磁盘最新文档为基底，仅用内存中 owned 顶层键覆盖，
	 * 其余顶层键（v1 分区/未知键）以磁盘为准保留，避免并存期互相覆盖。
	 */
	private async buildPersistSnapshot(): Promise<Record<string, unknown>> {
		const memory = this.document ?? { ...EMPTY_DOCUMENT };
		let base: Record<string, unknown> = { ...memory };

		try {
			const adapter = this.app.vault.adapter;
			const filePath = this.getFilePath();
			const parsed = await readWithTransientParseRetry(async () => {
				if (!(await adapter.exists(filePath))) {
					return null;
				}
				const raw = await adapter.read(filePath);
				return raw?.trim() ? (JSON.parse(raw) as unknown) : null;
			});
			if (parsed && isRecord(parsed)) {
				base = { ...parsed };
			}
		} catch (error) {
			logger.warn(`[SchemaV2Store] 持久化前重读失败，使用内存快照: ${this.getFilePath()}`, error);
		}

		const snapshot: Record<string, unknown> = { ...base };
		const memoryRecord = memory as unknown as Record<string, unknown>;
		for (const key of Object.keys(memory)) {
			if (OWNED_TOP_LEVEL_KEYS.has(key)) {
				if (this.deletedOwnedKeys.has(key)) {
					delete snapshot[key];
				} else {
					snapshot[key] = memoryRecord[key];
				}
			}
		}
		// 显式删除的 owned 键（即使已不在内存中）也从磁盘文档移除
		for (const key of this.deletedOwnedKeys) {
			delete snapshot[key];
		}
		// schemaVersion 恒定
		snapshot.schemaVersion = WEAVE_DATA_SCHEMA_VERSION;
		return snapshot;
	}
}
