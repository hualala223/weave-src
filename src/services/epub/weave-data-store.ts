/**
 * 统一数据存储核心（v4.0：weave-data.json 单一数据文件）
 *
 * 设计：
 * - 唯一数据文件：<dataPath>/weave-data.json（默认 CONFIG/STORAGE/weave-data.json）
 * - 原子写：临时文件 + rename（复用 epub-unified-local-data-store 的原子写）
 * - 节流落盘：updateSection/mutate 后延迟合并写盘；flush() 立即写盘
 * - schema 版本：schemaVersion 字段，后续升级时按版本迁移
 * - 领域分区：bookmarks/progress/highlights/shelf/traceability 逐域落位
 * - 未知顶层键保留（不破坏未来/外部写入的数据）
 */
import type { App } from "obsidian";
import { normalizeDataPath, resolveWeaveDataFilePath } from "../../config/paths";
import { DirectoryUtils } from "../../utils/directory-utils";
import { logger } from "../../utils/logger";
import {
	readWithTransientParseRetry,
	writeUnifiedLocalDataAtomically,
} from "./epub-unified-local-data-store";

/** 当前 schema 版本。 */
export const WEAVE_DATA_SCHEMA_VERSION = 1;

/** 领域分区键。 */
export type WeaveDataSectionKey =
	| "bookmarks"
	| "progress"
	| "highlights"
	| "shelf"
	| "traceability"
	| "books"
	| "bookshelfMembership"
	| "bookshelfPlaylists"
	| "readerSettings"
	| "excerptSettings"
	| "canvasBindings"
	| "canvasExcerptAnchors"
	| "uiMemory"
	| "tocChapterMarkSettings";

/** weave-data.json 文档结构。领域分区由各迁移逐步填充类型。 */
export interface WeaveDataDocument {
	schemaVersion: number;
	updatedAt?: number;
	bookmarks?: unknown;
	progress?: unknown;
	highlights?: unknown;
	shelf?: unknown;
	traceability?: unknown;
	books?: unknown;
	bookshelfMembership?: unknown;
	bookshelfPlaylists?: unknown;
	readerSettings?: unknown;
	excerptSettings?: unknown;
	canvasBindings?: unknown;
	canvasExcerptAnchors?: unknown;
	uiMemory?: unknown;
	tocChapterMarkSettings?: unknown;
	[key: string]: unknown;
}

/** 默认落盘节流延迟。 */
export const WEAVE_DATA_PERSIST_DELAY_MS = 400;

const EMPTY_DOCUMENT: WeaveDataDocument = {
	schemaVersion: WEAVE_DATA_SCHEMA_VERSION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 单例 store 缓存（按 App + 数据路径）。 */
const storeByApp = new WeakMap<App, Map<string, WeaveDataStore>>();

export function getWeaveDataStore(
	app: App,
	getDataPath: () => string
): WeaveDataStore {
	let stores = storeByApp.get(app);
	if (!stores) {
		stores = new Map<string, WeaveDataStore>();
		storeByApp.set(app, stores);
	}
	const dataPath = normalizeDataPath(getDataPath());
	let store = stores.get(dataPath);
	if (!store) {
		store = new WeaveDataStore(app, getDataPath);
		stores.set(dataPath, store);
	}
	return store;
}

export class WeaveDataStore {
	private document: WeaveDataDocument | null = null;
	private loadPromise: Promise<WeaveDataDocument> | null = null;
	private persistTimer: number | null = null;
	private persistPromise: Promise<void> = Promise.resolve();
	private dirty = false;

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
	async getDocument(): Promise<WeaveDataDocument> {
		if (this.document) {
			return this.document;
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadDocument();
		}
		return this.loadPromise;
	}

	/** 同步读取内存中的文档（未加载时返回空文档，不触发 IO）。 */
	getCachedDocument(): WeaveDataDocument {
		return this.document ?? { ...EMPTY_DOCUMENT };
	}

	/** 读取某个领域分区（未写入时为 undefined）。 */
	async getSection<T>(key: WeaveDataSectionKey): Promise<T | undefined> {
		const document = await this.getDocument();
		return document[key] as T | undefined;
	}

	/** 更新某个领域分区（undefined = 删除该分区）并节流落盘。 */
	updateSection(key: WeaveDataSectionKey, value: unknown): void {
		this.mutate((document) => {
			if (value === undefined) {
				delete document[key];
			} else {
				document[key] = value;
			}
		});
	}

	/**
	 * 内存中变更文档（同步），并调度节流落盘。
	 * 调用方应直接修改传入的 document 对象。
	 */
	mutate(mutator: (document: WeaveDataDocument) => void): void {
		const document = this.getCachedDocument();
		mutator(document);
		this.document = document;
		this.schedulePersist();
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
	}

	private async loadDocument(): Promise<WeaveDataDocument> {
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
				const document: WeaveDataDocument = {
					...EMPTY_DOCUMENT,
					...parsed,
				};
				// 显式保留未知顶层键（未来版本/外部写入）
				for (const [key, value] of Object.entries(parsed)) {
					if (!(key in EMPTY_DOCUMENT)) {
						document[key] = value;
					}
				}
				this.document = document;
				return document;
			}
		} catch (error) {
			logger.warn(`[WeaveDataStore] 读取失败: ${filePath}`, error);
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
		}, WEAVE_DATA_PERSIST_DELAY_MS);
	}

	private async persistPending(): Promise<void> {
		if (!this.dirty && !this.document) {
			await this.persistPromise;
			return;
		}
		const snapshot = JSON.parse(JSON.stringify(this.document ?? EMPTY_DOCUMENT)) as WeaveDataDocument;
		this.dirty = false;

		this.persistPromise = this.persistPromise.then(async () => {
			try {
				const adapter = this.app.vault.adapter;
				const filePath = this.getFilePath();
				await DirectoryUtils.ensureDirForFile(adapter, filePath);
				await writeUnifiedLocalDataAtomically(
					adapter,
					filePath,
					`${JSON.stringify(snapshot, null, 2)}\n`
				);
			} catch (error) {
				logger.warn(`[WeaveDataStore] 写入失败: ${this.getFilePath()}`, error);
				this.dirty = true;
			}
		});

		await this.persistPromise;
	}
}