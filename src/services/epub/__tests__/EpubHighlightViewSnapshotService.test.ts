import { describe, expect, it, vi } from "vitest";
import { EpubHighlightViewSnapshotService } from "../EpubHighlightViewSnapshotService";

describe("EpubHighlightViewSnapshotService", () => {
	it("returns a render-ready snapshot before page labels finish hydrating", async () => {
		const pageLabelResolvers: Array<(value: number) => void> = [];
		const service = new EpubHighlightViewSnapshotService();
		const readerService = {
			canonicalizeLocation: vi.fn(async (cfi: string) => cfi),
			getPageNumberFromCfi: vi.fn(
				() =>
					new Promise<number>((resolve) => {
						pageLabelResolvers.push(resolve);
					}),
			),
		} as any;

		const fastSnapshot = await service.revalidateSnapshot({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			preloadedHighlights: [
				{
					cfiRange: "epubcfi(/6/2)",
					color: "green",
					text: "第一条摘录 #tag",
					commentText: "想法正文",
					hasCommentDivider: true,
					sourceFile: "Notes/demo.md",
					sourceRef: "block-1",
					createdTime: 12,
					style: "underline",
					presentation: "highlight",
				},
			] as any,
			readerService,
			highlightRevision: 1,
		});

		expect(fastSnapshot.highlights).toHaveLength(1);
		expect(fastSnapshot.highlights[0]).toMatchObject({
			text: "第一条摘录 #tag",
			commentText: "想法正文",
			color: "green",
			colorLabel: "绿色",
			noteType: "下划线",
			noteTypeKey: "underline",
			sourceFile: "Notes/demo.md",
			sourceRef: "block-1",
			pageLabel: "",
		});
		expect(fastSnapshot.highlights[0].tags).toEqual(["tag"]);
		expect(fastSnapshot.pageLabelsResolved).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 0));
		pageLabelResolvers[0]?.(7);
		const hydratedSnapshot = await service.hydratePageLabels({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			readerService,
			highlightRevision: 1,
		});

		expect(hydratedSnapshot?.pageLabelsResolved).toBe(true);
		expect(hydratedSnapshot?.highlights[0]?.pageLabel).toBe("p.7");
	});

	it("keeps the stale snapshot available after invalidation until refresh completes", async () => {
		const service = new EpubHighlightViewSnapshotService();

		const firstSnapshot = await service.revalidateSnapshot({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			preloadedHighlights: [
				{
					cfiRange: "epubcfi(/6/2)",
					color: "yellow",
					text: "旧摘录",
					sourceFile: "Notes/old.md",
					createdTime: 1,
					presentation: "highlight",
				},
			] as any,
			readerService: null,
			highlightRevision: 1,
		});
		expect(firstSnapshot.highlights[0]?.text).toBe("旧摘录");

		service.invalidate("book-1", "Books/demo.epub");
		expect(
			service.getCachedSnapshot({
				bookId: "book-1",
				filePath: "Books/demo.epub",
				showStrikethroughHighlights: false,
			})?.highlights[0]?.text,
		).toBe("旧摘录");

		const refreshedSnapshot = await service.revalidateSnapshot({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			preloadedHighlights: [
				{
					cfiRange: "epubcfi(/6/4)",
					color: "blue",
					text: "新摘录",
					sourceFile: "Notes/new.md",
					createdTime: 2,
					presentation: "highlight",
				},
			] as any,
			readerService: null,
			highlightRevision: 2,
		});

		expect(refreshedSnapshot.highlights[0]?.text).toBe("新摘录");
	});

	it("透传宿主算好的彩色摘要 quoteHtml（按 cfiRange 匹配）", async () => {
		const service = new EpubHighlightViewSnapshotService();
		const highlights = [
			{
				cfiRange: "epubcfi(/6/2)",
				color: "yellow",
				text: "今天天气真好啊",
				sourceFile: "Notes/demo.md",
				createdTime: 1,
				presentation: "highlight",
			},
		] as any;
		const quoteHtmlByCfiRange = new Map<string, string>([
			["epubcfi(/6/2)", '今天<span style="color:#dc2626">天气</span>真好啊'],
		]);

		const snapshot = await service.publishFromHighlights({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			revision: 1,
			highlights,
			readerService: null,
			quoteHtmlByCfiRange,
		});

		expect(snapshot.highlights[0]?.text).toBe("今天天气真好啊");
		expect(snapshot.highlights[0]?.quoteHtml).toBe(
			'今天<span style="color:#dc2626">天气</span>真好啊',
		);
	});

	it("无 quoteHtmlByCfiRange 时卡片回退纯文本（quoteHtml 为 undefined）", async () => {
		const service = new EpubHighlightViewSnapshotService();

		const snapshot = await service.publishFromHighlights({
			bookId: "book-1",
			filePath: "Books/demo.epub",
			showStrikethroughHighlights: false,
			revision: 1,
			highlights: [
				{
					cfiRange: "epubcfi(/6/2)",
					color: "yellow",
					text: "纯文本摘录",
					createdTime: 1,
					presentation: "highlight",
				},
			] as any,
			readerService: null,
		});

		expect(snapshot.highlights[0]?.quoteHtml).toBeUndefined();
		expect(snapshot.highlights[0]?.text).toBe("纯文本摘录");
	});
});
