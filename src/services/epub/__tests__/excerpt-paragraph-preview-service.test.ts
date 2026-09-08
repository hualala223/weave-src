import { describe, expect, it } from "vitest";
import {
	ExcerptParagraphPreviewService,
	type ExcerptPreviewEngineFactory,
} from "../excerpt-paragraph-preview-service";
import type { EpubReaderEngine, ReaderParagraph } from "../reader-engine-types";

function makeParagraph(text: string, chapterIndex: number, cfiBase: string): ReaderParagraph {
	return {
		id: `p:${chapterIndex}:${text.slice(0, 4)}`,
		chapterIndex,
		chapterTitle: `第${chapterIndex + 1}章`,
		chapterHref: `ch${chapterIndex}.xhtml`,
		text,
		cfiRange: `${cfiBase},/1:0,/1:${text.length})`,
	};
}

interface FakeChapter {
	texts: string[];
	cfiBase: string;
}

function createFakeEngine(chapters: FakeChapter[]): EpubReaderEngine {
	const paragraphsByChapter = chapters.map((chapter, index) =>
		chapter.texts.map((text) => makeParagraph(text, index, chapter.cfiBase))
	);
	const engine = {
		loadEpub: async () => ({}) as never,
		destroy: () => {},
		getSectionIndexForCfi: async () => null,
		canonicalizeLocation: async () => null,
		getSectionHrefByChapterIndex: async (index: number) =>
			index >= 0 && index < chapters.length ? `ch${index}.xhtml` : null,
		getParagraphsForChapter: async (chapterIndex: number) =>
			paragraphsByChapter[chapterIndex] ?? [],
	} as unknown as EpubReaderEngine;
	return engine;
}

function createFactory(engine: EpubReaderEngine): {
	factory: ExcerptPreviewEngineFactory;
	instances: EpubReaderEngine[];
} {
	const instances: EpubReaderEngine[] = [];
	const factory: ExcerptPreviewEngineFactory = () => {
		instances.push(engine);
		return engine;
	};
	return { factory, instances };
}

const CFI = "epubcfi(/6/99!/4/2,/1:0,/1:10)";
const TEXT = "窗外的雨下个不停";

describe("ExcerptParagraphPreviewService", () => {
	it("CFI 直接命中的章节里有匹配段落时直接返回", async () => {
		const engine = createFakeEngine([{ texts: ["别的段落。", "窗外的雨下个不停，屋檐滴水。"], cfiBase: "epubcfi(/6/2!/4/2" }]);
		(engine.getSectionIndexForCfi as unknown as () => Promise<number>) = async () => 0;
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const preview = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		expect(preview.status).toBe("found");
		expect(preview.paragraphText).toContain("窗外的雨");
		expect(preview.highlight).not.toBeNull();
		service.dispose();
	});

	it("CFI 索引指向空章节时，canonicalizeLocation 文本纠偏兜底命中", async () => {
		const engine = createFakeEngine([
			{ texts: ["第一章内容。"], cfiBase: "epubcfi(/6/2!/4/2" },
			{ texts: ["窗外的雨下个不停，屋檐滴水。"], cfiBase: "epubcfi(/6/4!/4/2" },
		]);
		(engine.getSectionIndexForCfi as unknown as (cfi: string) => Promise<number>) = async (cfi: string) =>
			cfi === "canonical-cfi" ? 1 : 5;
		(engine.canonicalizeLocation as unknown as () => Promise<string | null>) = async () => "canonical-cfi";
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const preview = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		expect(preview.status).toBe("found");
		expect(preview.chapterTitle).toBe("第2章");
		service.dispose();
	});

	it("CFI 索引偏移时邻居章节兜底命中", async () => {
		const engine = createFakeEngine([
			{ texts: ["窗外的雨下个不停，屋檐滴水。"], cfiBase: "epubcfi(/6/2!/4/2" },
			{ texts: ["第二章内容。"], cfiBase: "epubcfi(/6/4!/4/2" },
		]);
		(engine.getSectionIndexForCfi as unknown as () => Promise<number>) = async () => 1;
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const preview = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		expect(preview.status).toBe("found");
		expect(preview.chapterTitle).toBe("第1章");
		service.dispose();
	});

	it("邻居扫描仍未命中时全书扫描兜底命中", async () => {
		const engine = createFakeEngine([
			{ texts: ["第一章内容。"], cfiBase: "epubcfi(/6/2!/4/2" },
			{ texts: ["第二章内容。"], cfiBase: "epubcfi(/6/4!/4/2" },
			{ texts: ["最深处藏着窗外的雨下个不停这句。"], cfiBase: "epubcfi(/6/8!/4/2" },
		]);
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const preview = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		expect(preview.status).toBe("found");
		expect(preview.chapterTitle).toBe("第3章");
		service.dispose();
	});

	it("解析结果缓存：第二次调用不再访问引擎段落", async () => {
		const engine = createFakeEngine([{ texts: ["窗外的雨下个不停。"], cfiBase: "epubcfi(/6/2!/4/2" }]);
		let paragraphCalls = 0;
		const wrapped = engine.getParagraphsForChapter as unknown as (index: number) => Promise<ReaderParagraph[]>;
		engine.getParagraphsForChapter = async (index: number) => {
			paragraphCalls += 1;
			return wrapped(index);
		};
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const first = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		const callsAfterFirst = paragraphCalls;
		const second = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });

		expect(first.status).toBe("found");
		expect(second.status).toBe("found");
		expect(paragraphCalls).toBe(callsAfterFirst);
		service.dispose();
	});

	it("全书扫完仍无命中时返回 unavailable（不抛错）", async () => {
		const engine = createFakeEngine([{ texts: ["完全无关的内容。"], cfiBase: "epubcfi(/6/2!/4/2" }]);
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		const preview = await service.getPreview({ filePath: "b.epub", cfi: CFI, excerptText: TEXT });
		expect(preview.status).toBe("unavailable");
		expect(preview.paragraphText).toBe("");
		service.dispose();
	});

	it("缺 filePath 或 cfi 时返回 unavailable", async () => {
		const engine = createFakeEngine([]);
		const { factory } = createFactory(engine);
		const service = new ExcerptParagraphPreviewService({} as never, factory);

		expect((await service.getPreview({ filePath: "", cfi: CFI, excerptText: TEXT })).status).toBe("unavailable");
		expect((await service.getPreview({ filePath: "b.epub", cfi: "", excerptText: TEXT })).status).toBe("unavailable");
		service.dispose();
	});
});
