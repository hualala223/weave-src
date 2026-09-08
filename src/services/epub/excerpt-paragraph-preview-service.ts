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
}

export function unavailablePreview(
	failureReason?: ExcerptParagraphPreviewFailureReason
): ExcerptParagraphPreview {
	return {
		status: "unavailable",
		chapterTitle: "",
		paragraphText: "",
		highlight: null,
		failureReason,
	};
}

export type ExcerptPreviewEngineFactory = (app: App) => EpubReaderEngine;

interface PreviewRequest {
	filePath: string;
	cfi: string;
	excerptText: string;
}

/** 全书文本扫描的章节上限（仅在主路径失败时触发，命中前逐章解析并有引擎级缓存）。 */
const MAX_SCAN_CHAPTERS = 2000;
const MAX_CACHED_BOOKS = 4;

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
		const filePath = String(request?.filePath || "").trim();
		const cfi = String(request?.cfi || "").trim();
		const excerptText = String(request?.excerptText || "").trim();
		if (!filePath || !cfi) {
			return unavailablePreview();
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
		try {
			const engine = await this.getEngine(filePath);

			// 1) CFI 直接解析；2) 文本纠偏（canonicalizeLocation）后的章节。
			const candidateIndexes: number[] = [];
			const primaryIndex = await engine.getSectionIndexForCfi?.(cfi);
			if (typeof primaryIndex === "number" && primaryIndex >= 0) {
				candidateIndexes.push(primaryIndex);
			}
			if (excerptText) {
				const canonical = await engine.canonicalizeLocation?.(cfi, excerptText);
				const canonicalIndex =
					typeof canonical === "string" && canonical
						? await engine.getSectionIndexForCfi?.(canonical)
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
				const found = await this.tryMatchChapter(engine, chapterIndex, cfi, excerptText);
				if (found) {
					return found;
				}
				resolvedAnyChapter = true;
			}

			// 4) 全书逐章文本扫描（最重的一档，仅在以上全部落空时）。
			if (excerptText) {
				for (let chapterIndex = 0; chapterIndex < MAX_SCAN_CHAPTERS; chapterIndex++) {
					const href = await engine.getSectionHrefByChapterIndex?.(chapterIndex);
					if (!href) {
						break;
					}
					const found = await this.tryMatchChapter(engine, chapterIndex, cfi, excerptText);
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
			logger.warn("[ExcerptParagraphPreview] Failed to resolve paragraph preview:", error);
			this.enginePromises.delete(filePath);
			return unavailablePreview("book-load-failed");
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
		excerptText: string
	): Promise<ExcerptParagraphPreview | null> {
		const paragraphs: ReaderParagraph[] =
			(await engine.getParagraphsForChapter?.(chapterIndex, { includeHtml: false })) || [];
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
