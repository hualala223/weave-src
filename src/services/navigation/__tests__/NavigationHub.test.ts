vi.mock("obsidian", () => ({
	App: class MockApp {},
	WorkspaceLeaf: class MockWorkspaceLeaf {},
	normalizePath: (value: string) =>
		String(value || "")
			.replace(/\\/g, "/")
			.replace(/\/+/g, "/")
			.replace(/\/$/, ""),
}));

const {
	openBookForSourceNavigationMock,
	openEpubInPreferredLeafMock,
	resolveSourceFilePathMock,
} = vi.hoisted(() => ({
	openBookForSourceNavigationMock: vi.fn(),
	openEpubInPreferredLeafMock: vi.fn(),
	resolveSourceFilePathMock: vi.fn(async () => "Books/demo.epub"),
}));

vi.mock("../../../utils/epub-leaf-utils", () => ({
	openBookForSourceNavigation: openBookForSourceNavigationMock,
	openEpubInPreferredLeaf: openEpubInPreferredLeafMock,
}));

vi.mock("../../epub/epub-storage-access", () => ({
	getEpubStorageService: () => ({
		resolveSourceFilePath: resolveSourceFilePathMock,
	}),
}));

vi.mock("../../epub/epub-vault-path", () => ({
	resolveEpubVaultPath: (_app: unknown, path: string) => path,
}));

import { NavigationHub } from "../NavigationHub";

describe("NavigationHub", () => {
	const app = { vault: { getAbstractFileByPath: () => null } } as any;

	beforeEach(() => {
		openBookForSourceNavigationMock.mockReset();
		openEpubInPreferredLeafMock.mockReset();
		openBookForSourceNavigationMock.mockResolvedValue({ id: "leaf-source" });
		openEpubInPreferredLeafMock.mockResolvedValue({ id: "leaf-preferred" });
		resolveSourceFilePathMock.mockResolvedValue("Books/demo.epub");
	});

	it("reuses preferred reader leaves when reuseLeaf policy is set", async () => {
		const hub = new NavigationHub(app);
		const result = await hub.navigate({
			kind: "book",
			resourcePath: "Books/demo.epub",
			locate: { cfi: "epubcfi(/6/2)", text: "Hello" },
			policy: { reuseLeaf: true, focus: true },
		});

		expect(result.success).toBe(true);
		expect(openEpubInPreferredLeafMock).toHaveBeenCalledWith(
			app,
			"Books/demo.epub",
			expect.objectContaining({
				filePath: "Books/demo.epub",
				pendingLocate: { cfi: "epubcfi(/6/2)", text: "Hello" },
				pendingCfi: "epubcfi(/6/2)",
				pendingText: "Hello",
			})
		);
		expect(openBookForSourceNavigationMock).not.toHaveBeenCalled();
	});

	it("uses preferred leaf policy for bookshelf-style opens", async () => {
		const hub = new NavigationHub(app);
		await hub.navigate({
			kind: "book",
			resourcePath: "Books/demo.epub",
			policy: { preferredLeaf: true, focus: true },
		});

		expect(openEpubInPreferredLeafMock).toHaveBeenCalledWith(
			app,
			"Books/demo.epub",
			expect.objectContaining({ filePath: "Books/demo.epub" })
		);
		expect(openBookForSourceNavigationMock).not.toHaveBeenCalled();
	});

	it("allows located book navigation", async () => {
		const hub = new NavigationHub(app);
		const result = await hub.navigate({
			kind: "book",
			resourcePath: "Books/demo.epub",
			locate: { cfi: "epubcfi(/6/2)", text: "Hello" },
		});

		expect(result.success).toBe(true);
		expect(openBookForSourceNavigationMock).toHaveBeenCalled();
	});

	it("allows located navigation for non-epub supported formats", async () => {
		resolveSourceFilePathMock.mockResolvedValueOnce("Books/demo.cbz");
		const hub = new NavigationHub(app);
		const result = await hub.navigate({
			kind: "book",
			resourcePath: "Books/demo.cbz",
			locate: { cfi: "epubcfi(/6/2)", text: "Page 3" },
		});

		expect(result.success).toBe(true);
		expect(openBookForSourceNavigationMock).toHaveBeenCalled();
	});

	it("allows opening a book without a locate target", async () => {
		const hub = new NavigationHub(app);
		const result = await hub.navigate({
			kind: "book",
			resourcePath: "Books/demo.mobi",
			policy: { preferredLeaf: true, focus: true },
		});

		expect(result.success).toBe(true);
		expect(openEpubInPreferredLeafMock).toHaveBeenCalled();
	});
});
