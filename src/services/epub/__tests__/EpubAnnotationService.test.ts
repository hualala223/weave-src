vi.mock('obsidian', () => ({
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
	normalizePath: (value: string) => String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, ''),
}));

import { EpubAnnotationService } from '../EpubAnnotationService';

describe('EpubAnnotationService', () => {
	it('clears legacy stored highlights at most once per book and keeps backlink highlights as the live source', async () => {
		let concealedTexts: any[] = [];

		const storageService = {
			removeLegacyHighlights: vi.fn(async () => {}),
			loadConcealedTexts: vi.fn(async () => concealedTexts),
			saveConcealedTexts: vi.fn(async (_bookId: string, nextConcealedTexts: typeof concealedTexts) => {
				concealedTexts = nextConcealedTexts;
			}),
			getCanvasBinding: vi.fn(async () => null),
		} as any;

		const backlinkHighlights = [
			{
				cfiRange: 'epubcfi(/6/2[chapter-1]!/4/2)',
				color: 'green',
				text: 'Live highlight',
				sourceFile: 'Notes/demo.md',
				sourceRef: 'block-ref',
				createdTime: 2,
				presentation: 'highlight',
			},
		];
		const backlinkService = {
			collectHighlights: vi.fn(async () => backlinkHighlights),
		} as any;

		const service = new EpubAnnotationService(storageService);

		await expect(service.collectAllHighlights('book-1', 'Books/demo.epub', backlinkService)).resolves.toEqual([
			{
				...backlinkHighlights[0],
				sourceLocators: [
					{
						sourceFile: 'Notes/demo.md',
						sourceRef: 'block-ref',
					},
				],
			},
		]);
		expect(storageService.removeLegacyHighlights).toHaveBeenCalledTimes(1);

		await expect(service.collectAllHighlights('book-1', 'Books/demo.epub', backlinkService)).resolves.toEqual([
			{
				...backlinkHighlights[0],
				sourceLocators: [
					{
						sourceFile: 'Notes/demo.md',
						sourceRef: 'block-ref',
					},
				],
			},
		]);
		expect(backlinkService.collectHighlights).toHaveBeenCalledTimes(1);

		service.invalidateCollectedHighlightsCache('book-1', 'Books/demo.epub');

		await expect(service.collectAllHighlights('book-1', 'Books/demo.epub', backlinkService)).resolves.toEqual([
			{
				...backlinkHighlights[0],
				sourceLocators: [
					{
						sourceFile: 'Notes/demo.md',
						sourceRef: 'block-ref',
					},
				],
			},
		]);
		expect(backlinkService.collectHighlights).toHaveBeenCalledTimes(2);
	});

	it('keeps separate highlights for the same coarse cfi when excerpt ids differ', async () => {
		const storageService = {
			removeLegacyHighlights: vi.fn(async () => {}),
			loadConcealedTexts: vi.fn(async () => []),
			getCanvasBinding: vi.fn(async () => null),
		} as any;

		const backlinkService = {
			collectHighlights: vi.fn(async () => [
				{
					cfiRange: 'epubcfi(/6/26)',
					color: 'yellow',
					text: '第一段摘录',
					excerptId: 'excerpt-a',
					sourceFile: 'Notes/demo.md',
					createdTime: 1,
				},
				{
					cfiRange: 'epubcfi(/6/26)',
					color: 'green',
					text: '第二段摘录',
					excerptId: 'excerpt-b',
					sourceFile: 'Notes/demo.md',
					createdTime: 2,
				},
			]),
		} as any;

		const service = new EpubAnnotationService(storageService);

		await expect(service.collectAllHighlights('book-1', 'Books/demo.txt', backlinkService)).resolves.toEqual([
			expect.objectContaining({
				cfiRange: 'epubcfi(/6/26)',
				text: '第一段摘录',
				excerptId: 'excerpt-a',
			}),
			expect.objectContaining({
				cfiRange: 'epubcfi(/6/26)',
				text: '第二段摘录',
				excerptId: 'excerpt-b',
			}),
		]);
	});

	it('merges all source locators for the same cfi and preserves the preferred primary source', async () => {
		const storageService = {
			removeLegacyHighlights: vi.fn(async () => {}),
			loadConcealedTexts: vi.fn(async () => []),
			getCanvasBinding: vi.fn(async () => null),
		} as any;

		const backlinkService = {
			collectHighlights: vi.fn(async () => [
				{
					cfiRange: 'readium:shared',
					color: 'green',
					text: 'Shared highlight',
					sourceFile: 'Notes/demo.md',
					createdTime: 2,
				},
				{
					cfiRange: 'readium:shared',
					color: 'green',
					style: 'wavy',
					text: 'Shared highlight',
					commentText: '想法正文',
					hasCommentDivider: true,
					sourceFile: 'weave/memory/deck-files/demo_01.wdeck',
					sourceRef: 'card:card-a',
					createdTime: 2,
				},
			]),
		} as any;

		const service = new EpubAnnotationService(storageService);

		await expect(service.collectAllHighlights('book-1', 'Books/demo.epub', backlinkService)).resolves.toEqual([
			{
				cfiRange: 'readium:shared',
				color: 'green',
				style: 'wavy',
				text: 'Shared highlight',
				commentText: '想法正文',
				hasCommentDivider: true,
				sourceFile: 'weave/memory/deck-files/demo_01.wdeck',
				sourceRef: 'card:card-a',
				sourceLocators: [
					{
						sourceFile: 'Notes/demo.md',
						sourceRef: undefined,
					},
					{
						sourceFile: 'weave/memory/deck-files/demo_01.wdeck',
						sourceRef: 'card:card-a',
					},
				],
				createdTime: 2,
				presentation: 'highlight',
			},
		]);
	});

	it('prefers canvas file-node locators as the primary backlink target when present alongside a markdown excerpt source', async () => {
		const storageService = {
			removeLegacyHighlights: vi.fn(async () => {}),
			loadConcealedTexts: vi.fn(async () => []),
			getCanvasBinding: vi.fn(async () => null),
		} as any;

		const backlinkService = {
			collectHighlights: vi.fn(async () => [
				{
					cfiRange: 'readium:canvas-shared',
					color: 'purple',
					text: 'Canvas shared highlight',
					sourceFile: 'Notes/demo.md',
					excerptId: 'excerpt-fixed',
					sourceLocators: [
						{
							sourceFile: 'Canvas/demo.canvas',
							sourceRef: 'canvas-file-node:file-node-1',
							excerptId: 'excerpt-fixed',
						},
					],
					createdTime: 3,
				},
			]),
		} as any;

		const service = new EpubAnnotationService(storageService);

		await expect(service.collectAllHighlights('book-1', 'Books/demo.epub', backlinkService)).resolves.toEqual([
			{
				cfiRange: 'readium:canvas-shared',
				color: 'purple',
				text: 'Canvas shared highlight',
				sourceFile: 'Canvas/demo.canvas',
				sourceRef: 'canvas-file-node:file-node-1',
				excerptId: 'excerpt-fixed',
				sourceLocators: [
					{
						sourceFile: 'Notes/demo.md',
						sourceRef: undefined,
						excerptId: 'excerpt-fixed',
					},
					{
						sourceFile: 'Canvas/demo.canvas',
						sourceRef: 'canvas-file-node:file-node-1',
						excerptId: 'excerpt-fixed',
					},
				],
				createdTime: 3,
				presentation: 'highlight',
			},
		]);
	});
});
