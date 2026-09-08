import type { App } from "obsidian";
import { createEpubReaderEngine } from "./reader-engine-factory";
import type { EpubReaderEngine, ReaderParagraph } from "./reader-engine-types";
import {
	resolveExcerptParagraph,
	type ExcerptParagraphHighlight,
} from "./excerpt-paragraph-resolver";
import { logger } from "../../utils/logger";

export type ExcerptParagraphPreviewStatus = "found" | "unavailable";

export type ExcerptParagraphPreviewFailureReason =
	| "book-load-failed"
	| "chapter-unresolved"
	| "text-not-found";

export interface ExcerptParagraphPreview {
	status: ExcerptParagraphPreviewStatus;
	/** 章节标题（解析失败时为空串）。 */
	chapterTitle: string;
	/** 完整段落文本（失败时为空串）。 */
	paragraphText: string;
	/** 划线覆盖区间（paragraphText 上的原始偏移）；不可计算时为 null。 */
	highlight: ExcerptParagraphHighlight | null;
	/** status 为 unavailable 时的失败原因。 */
	failureReason?: ExcerptParagraphPreviewFailureReason;
	/** 首个异常的原始错误信息（用于浮框内直接呈现，便于定位环境差异）。 */
	failureDetail?: string;
}

export function unavailablePreview(
	failureReason?: ExcerptParagraphPreviewFailureReason,
	failureDetail?: string
): ExcerptParagraphPreview {
	return {
		status: "unavailable",
		chapterTitle: "",
		paragraphText: "",
		highlight: null,
		failureReason,
		failureDetail,
	};
}

export type ExcerptPreviewEngineFactory = (app: App) => EpubReaderEngine;

interface PreviewRequest {
	filePath: string;
	cfi: string;
	excerptText: string;
	/** 承载摘录块的笔记路径（用于 Obsidian 链接解析的相对解析基准）。 */
	sourcePath?: string;
}

/** 全书文本扫描的章节上限（仅在主路径失败时触发，命中前逐章解析并有引擎级缓存）。 */
const MAX_SCAN_CHAPTERS = 2000;
const MAX_CACHED_BOOKS = 4;

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

interface VaultFileLike {
	path: string;
}

interface VaultLike {
	getAbstractFileByPath?: (path: string) => VaultFileLike | null;
	getFiles?: () => VaultFileLike[];
}

interface MetadataCacheLike {
	getFirstLinkpathDest?: (linkpath: string, sourcePath: string) => VaultFileLike | null;
}

/** 链接里写的路径 → vault 真实文件路径。 */
export function resolveVaultBookFilePath(
	app: App,
	rawPath: string,
	sourcePath?: string
): string | null {
	const vault = (app as { vault?: VaultLike }).vault;
	if (!vault) {
		return rawPath;
	}
	const candidates = [rawPath];
	try {
		const decoded = decodeURIComponent(rawPath);
		if (decoded !== rawPath) {
			candidates.push(decoded);
		}
	} catch {
		// 非法编码序列：忽略，仅用原始串。
	}

	// 1) 全路径精确匹配。
	for (const candidate of candidates) {
		const file = vault.getAbstractFileByPath?.(candidate);
		if (file?.path) {
			return file.path;
		}
	}

	// 2) Obsidian 链接解析（容忍省略文件夹、最短路径、缺扩展名等链接写法）。
	const metadataCache = (app as { metadataCache?: MetadataCacheLike }).metadataCache;
	if (typeof metadataCache?.getFirstLinkpathDest === "function") {
		for (const candidate of candidates) {
			const dest = metadataCache.getFirstLinkpathDest(candidate, String(sourcePath || ""));
			if (dest?.path) {
				return dest.path;
			}
		}
	}

	// 3) 全库扫描：按归一化路径后缀匹配，再退到唯一文件名匹配。
	const files = typeof vault.getFiles === "function" ? vault.getFiles() : [];
	const normalize = (value: string) =>
		value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").toLowerCase();
	const normalizedTargets = candidates.map(normalize);
	const matchedBySuffix = files.filter((file) => {
		const normalizedPath = normalize(file.path);
		return normalizedTargets.some(
			(target) => normalizedPath === target || normalizedPath.endsWith(`/${target}`)
		);
	});
	if (matchedBySuffix.length === 1) {
		return matchedBySuffix[0].path;
	}
	if (matchedBySuffix.length > 1) {
		return matchedBySuffix[0].path;
	}
	for (const candidate of candidates) {
		const baseName = normalize(candidate).split("/").pop() || "";
		if (!baseName) {
			continue;
		}
		const matchedByName = files.filter(
			(file) => normalize(file.path).split("/").pop() === baseName
		);
		if (matchedByName.length >= 1) {
			return matchedByName[0].path;
		}
	}
	return null;
}

/**
 * 段落预览浮框的数据源：以「脱离 UI 的引擎实例」离线加载书籍
 * （loadEpub 不 renderTo），解析 CFI → 章节 → 段落列表 → 命中段落。
 *
 * 章节归属按层级兜底（真实摘录的 CFI 可能因书改版/引擎索引偏移对不上）：
 * 1) CFI 直接解析章节；2) canonicalizeLocation 以摘录文本纠偏后的章节；
 * 3) 上述章节的邻居；4) 全书逐章文本扫描。
 * 按书籍文件缓存引擎实例（单飞），解析结果按 定位+文本 缓存，会话生命周期内有效。
 */
export class ExcerptParagraphPreviewService {
	private app: App;
	private engineFactory: ExcerptPreviewEngineFactory;
	private enginePromises = new Map<string, Promise<EpubReaderEngine>>();
	private resultCache = new Map<string, ExcerptParagraphPreview>();

	constructor(app: App, engineFactory: ExcerptPreviewEngineFactory = createEpubReaderEngine) {
		this.app = app;
		this.engineFactory = engineFactory;
	}

	async getPreview(request: PreviewRequest): Promise<ExcerptParagraphPreview> {
		const rawPath = String(request?.filePath || "").trim();
		const cfi = String(request?.cfi || "").trim();
		const excerptText = String(request?.excerptText || "").trim();
		const sourcePath = String(request?.sourcePath || "");
		if (!rawPath || !cfi) {
			return unavailablePreview();
		}

		// 链接里的书路径可能是省略文件夹/最短路径/URI 编码等写法，先解析为 vault 真实路径。
		const filePath = resolveVaultBookFilePath(this.app, rawPath, sourcePath);
		if (!filePath) {
			logger.warn(`[ExcerptParagraphPreview] Book file not found in vault: ${rawPath}`);
			return unavailablePreview("book-load-failed", `书库中找不到书籍文件：${rawPath}`);
		}

		const cacheKey = `${filePath}\u0000${cfi}\u0000${excerptText}`;
		const cached = this.resultCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const preview = await this.resolvePreview(filePath, cfi, excerptText);
		// 书籍加载失败可能是暂时的（文件忙/首次解析超时），不缓存，允许下次悬停重试。
		if (preview.status === "found" || preview.failureReason !== "book-load-failed") {
			this.resultCache.set(cacheKey, preview);
		}
		return preview;
	}

	private async resolvePreview(
		filePath: string,
		cfi: string,
		excerptText: string
	): Promise<ExcerptParagraphPreview> {
		let resolvedAnyChapter = false;
		let firstError: unknown = null;
		// 单步容错包装：任何一步抛错都记录下来继续兜底，不中断整条链。
		const attempt = async <T>(operation: () => Promise<T> | T): Promise<T | null> => {
			try {
				return await operation();
			} catch (error) {
				firstError ||= error;
				logger.warn("[ExcerptParagraphPreview] Step failed (continuing fallback):", error);
				return null;
			}
		};

		try {
			const engine = await this.getEngine(filePath);

			// 1) CFI 直接解析；2) 文本纠偏（canonicalizeLocation）后的章节。
			const candidateIndexes: number[] = [];
			const primaryIndex = await attempt(() => engine.getSectionIndexForCfi?.(cfi));
			if (typeof primaryIndex === "number" && primaryIndex >= 0) {
				candidateIndexes.push(primaryIndex);
			}
			if (excerptText) {
				const canonical = await attempt(() => engine.canonicalizeLocation?.(cfi, excerptText));
				const canonicalIndex =
					typeof canonical === "string" && canonical
						? await attempt(() => engine.getSectionIndexForCfi?.(canonical))
						: null;
				if (typeof canonicalIndex === "number" && canonicalIndex >= 0) {
					candidateIndexes.push(canonicalIndex);
				}
			}
			// 3) 邻居章节（foliate 索引偶发 off-by-one）。
			const neighborIndexes = candidateIndexes.flatMap((index) => [index - 1, index + 1]);
			const orderedIndexes = [...candidateIndexes, ...neighborIndexes].filter(
				(index, position, all) => index >= 0 && all.indexOf(index) === position
			);
			for (const chapterIndex of orderedIndexes) {
				const found = await this.tryMatchChapter(engine, chapterIndex, cfi, excerptText, attempt);
				if (found) {
					return found;
				}
				resolvedAnyChapter = true;
			}

			// 4) 全书逐章文本扫描（最重的一档，仅在以上全部落空时）。
			if (excerptText) {
				for (let chapterIndex = 0; chapterIndex < MAX_SCAN_CHAPTERS; chapterIndex++) {
					const href = await attempt(() => engine.getSectionHrefByChapterIndex?.(chapterIndex));
					if (!href) {
						break;
					}
					const found = await this.tryMatchChapter(engine, chapterIndex, cfi, excerptText, attempt);
					if (found) {
						logger.warn(
							"[ExcerptParagraphPreview] Resolved via full-book scan at chapter",
							chapterIndex
						);
						return found;
					}
					resolvedAnyChapter = true;
				}
			}
		} catch (error) {
			// getEngine（书籍加载）失败：不缓存结果，下次悬停重试。
			firstError ||= error;
			logger.warn("[ExcerptParagraphPreview] Book load failed:", error);
			this.enginePromises.delete(filePath);
			return unavailablePreview("book-load-failed", describeError(error));
		}
		if (firstError) {
			const failureReason: ExcerptParagraphPreviewFailureReason = resolvedAnyChapter
				? "text-not-found"
				: "chapter-unresolved";
			return unavailablePreview(failureReason, describeError(firstError));
		}
		const failureReason: ExcerptParagraphPreviewFailureReason = resolvedAnyChapter
			? "text-not-found"
			: "chapter-unresolved";
		logger.warn(
			`[ExcerptParagraphPreview] Unavailable (${failureReason}) for cfi=${cfi} text="${excerptText.slice(0, 40)}"`
		);
		return unavailablePreview(failureReason);
	}

	private async tryMatchChapter(
		engine: EpubReaderEngine,
		chapterIndex: number,
		cfi: string,
		excerptText: string,
		attempt: <T>(operation: () => Promise<T> | T) => Promise<T | null>
	): Promise<ExcerptParagraphPreview | null> {
		const paragraphs: ReaderParagraph[] =
			(await attempt(() => engine.getParagraphsForChapter?.(chapterIndex, { includeHtml: false }))) ||
			[];
		if (!paragraphs.length) {
			return null;
		}
		const match = resolveExcerptParagraph({ excerptCfi: cfi, excerptText, paragraphs });
		if (match.status !== "matched" || !match.paragraph) {
			return null;
		}
		return {
			status: "found",
			chapterTitle: String(match.paragraph.chapterTitle || "").trim(),
			paragraphText: String(match.paragraph.text || ""),
			highlight: match.highlight,
		};
	}

	private getEngine(filePath: string): Promise<EpubReaderEngine> {
		const existing = this.enginePromises.get(filePath);
		if (existing) {
			return existing;
		}
		const created = (async () => {
			const engine = this.engineFactory(this.app);
			await engine.loadEpub(filePath);
			return engine;
		})();
		created.catch(() => {
			this.enginePromises.delete(filePath);
		});
		this.enginePromises.set(filePath, created);
		while (this.enginePromises.size > MAX_CACHED_BOOKS) {
			const oldestKey = this.enginePromises.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			const evicted = this.enginePromises.get(oldestKey);
			this.enginePromises.delete(oldestKey);
			void evicted
				?.then((engine) => engine.destroy())
				.catch((error) => logger.warn("[ExcerptParagraphPreview] Evicted engine destroy failed:", error));
		}
		return created;
	}

	dispose(): void {
		for (const promise of this.enginePromises.values()) {
			void promise
				.then((engine) => engine.destroy())
				.catch((error) => logger.warn("[ExcerptParagraphPreview] Engine destroy failed:", error));
		}
		this.enginePromises.clear();
		this.resultCache.clear();
	}
}
