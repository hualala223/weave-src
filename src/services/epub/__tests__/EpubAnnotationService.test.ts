vi.mock("obsidian", () => ({
	App: class MockApp {},
	TFile: class MockTFile {},
	ItemView: class MockItemView {},
	WorkspaceLeaf: class MockWorkspaceLeaf {},
	MarkdownView: class MockMarkdownView {},
	Notice: class MockNotice {
		constructor(_message?: string) {}
	},
	Menu: class MockMenu {},
	Modal: class MockModal {},
	Plugin: class MockPlugin {},
	PluginSettingTab: class MockPluginSettingTab {},
	Platform: { isMobile: false },
	setIcon: vi.fn(),
	normalizePath: (value: string) =>
		String(value || "")
			.replace(/\\/g, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, ""),
}));

import { EpubAnnotationService } from "../EpubAnnotationService";

describe("EpubAnnotationService", () => {
	it("creates, reads, and deletes concealed texts", async () => {
		let concealedTexts: any[] = [];

		const storageService = {
			addConcealedText: vi.fn(async (_bookId: string, concealedText: any) => {
				concealedTexts.push(concealedText);
			}),
			loadConcealedTexts: vi.fn(async () => concealedTexts),
			saveConcealedTexts: vi.fn(
				async (_bookId: string, nextConcealedTexts: any[]) => {
					concealedTexts = nextConcealedTexts;
				},
			),
		} as any;

		const service = new EpubAnnotationService(storageService);

		const created = await service.createConcealedText(
			"book-1",
			"隐藏文本",
			2,
			"epubcfi(/6/2[chapter-1]!/4/2)",
			"mask",
		);
		expect(created.text).toBe("隐藏文本");
		expect(created.cfiRange).toBe("epubcfi(/6/2[chapter-1]!/4/2)");
		expect(created.chapterIndex).toBe(2);
		expect(created.mode).toBe("mask");
		expect(created.createdTime).toBeGreaterThan(0);

		const loaded = await service.getConcealedTexts("book-1");
		expect(loaded).toHaveLength(1);

		await service.deleteConcealedTextByCfi(
			"book-1",
			"epubcfi(/6/2[chapter-1]!/4/2)",
		);
		expect(await service.getConcealedTexts("book-1")).toHaveLength(0);
	});
});
