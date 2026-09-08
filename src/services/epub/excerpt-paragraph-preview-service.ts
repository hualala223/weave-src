import type { App } from "obsidian";
import { createEpubReaderEngine } from "./reader-engine-factory";
import type { EpubReaderEngine } from "./reader-engine-types";
import { resolveExcerptParagraph, type ExcerptParagraphHighlight } from "./excerpt-paragraph-resolver";
import { logger } from "../../utils/logger";

export type ExcerptParagraphPreviewStatus = "found" | "unavailable";

export interface ExcerptParagraphPreview {
	status: ExcerptParagraphPreviewStatus;
	/** 章节标题（解析失败时为空串）。 */
	chapterTitle: string;
	/** 完整段落文本（失败时为空串）。 */
	paragraphText: string;
	/** 划线覆盖区间（paragraphText 上的原始偏移）；不可计算时为 null。 */
	highlight: ExcerptParagraphHighlight | null;
}

interface PreviewRequestKey {
	filePath: string;
	cfi: string;
	excerptText: string;
}

const MAX_CACHED_BOOKS = 4;

/**
 * 段落预览浮框的数据源：以「脱离 UI 的引擎实例」离线加载书籍
 * （loadEpub 不 renderTo），解析 CFI → 章节 → 段落列表 → 命中段落。
 * 按书籍文件缓存引擎实例（单飞），解析结果按 定位+文本 缓存，会话生命周期内有效。
 */
export class ExcerptParagraphPreviewService {
	private app: App;
	private enginePromises = new Map<string, Promise<EpubReaderEngine>>();
	private resultCache = new Map<string, ExcerptParagraphPreview>();

	constructor(app: App) {
		this.app = app;
	}

	async getPreview(request: PreviewRequestKey): Promise<ExcerptParagraphPreview> {
		const filePath = String(request?.filePath || "").trim();
		const cfi = String(request?.cfi || "").trim();
		const excerptText = String(request?.excerptText || "").trim();
		if (!filePath || !cfi) {
			return { status: "unavailable", chapterTitle: "", paragraphText: "", highlight: null };
		}

		const cacheKey = `${filePath}\u0000${cfi}\u0000${excerptText}`;
		const cached = this.resultCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const preview = await this.resolvePreview(filePath, cfi, excerptText);
		this.resultCache.set(cacheKey, preview);
		return preview;
	}

	private async resolvePreview(
		filePath: string,
		cfi: string,
		excerptText: string
	): Promise<ExcerptParagraphPreview> {
		const unavailable: ExcerptParagraphPreview = {
			status: "unavailable",
			chapterTitle: "",
			paragraphText: "",
			highlight: null,
		};
		try {
			const engine = await this.getEngine(filePath);
			const chapterIndex = await engine.getSectionIndexForCfi?.(cfi);
			if (typeof chapterIndex !== "number" || chapterIndex < 0) {
				return unavailable;
			}
			const paragraphs = (await engine.getParagraphsForChapter?.(chapterIndex, { includeHtml: false })) || [];
			if (!paragraphs.length) {
				return unavailable;
			}
			const match = resolveExcerptParagraph({ excerptCfi: cfi, excerptText, paragraphs });
			if (match.status !== "matched" || !match.paragraph) {
				return unavailable;
			}
			return {
				status: "found",
				chapterTitle: String(match.paragraph.chapterTitle || "").trim(),
				paragraphText: String(match.paragraph.text || ""),
				highlight: match.highlight,
			};
		} catch (error) {
			logger.warn("[ExcerptParagraphPreview] Failed to resolve paragraph preview:", error);
			this.enginePromises.delete(filePath);
			return unavailable;
		}
	}

	private getEngine(filePath: string): Promise<EpubReaderEngine> {
		const existing = this.enginePromises.get(filePath);
		if (existing) {
			return existing;
		}
		const created = (async () => {
			const engine = createEpubReaderEngine(this.app);
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
