import { describe, expect, it, vi } from "vitest";
import {
	buildImageAttachmentDir,
	buildImageAttachmentFileName,
	buildImageNoteBlock,
	buildImageNoteSuffix,
	extensionForImageMimeType,
	extractImageToNote,
	sanitizeBookFileSegment,
} from "../image-note-extractor";

const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);

function createFakeDeps(existingPaths: string[] = []) {
	const existing = new Set(existingPaths);
	const ensureDir = vi.fn(async () => {});
	const pathExists = vi.fn(async (path: string) => existing.has(path));
	const writeBinary = vi.fn(async () => {});
	const buildDeepLink = vi.fn(
		(input: { cfi: string; chapterIndex: number; chapterTitle?: string }) =>
			`[[书.epub#${input.cfi}|书]]`,
	);
	return {
		deps: {
			attachmentRoot: "CONFIG/asset",
			ensureDir,
			pathExists,
			writeBinary,
			buildDeepLink,
		},
		ensureDir,
		pathExists,
		writeBinary,
		buildDeepLink,
	};
}

describe("sanitizeBookFileSegment", () => {
	it("移除文件名非法字符、折叠空白、去掉首尾点与空格", () => {
		expect(sanitizeBookFileSegment(" 三体 / 黑暗森林: 上部*? ")).toBe(
			"三体 黑暗森林 上部",
		);
		expect(sanitizeBookFileSegment("..标题..")).toBe("标题");
		expect(sanitizeBookFileSegment('a#b^c[d]{e}|f\\g<h>i:j"k')).toBe(
			"abcdefghijk",
		);
	});

	it("净化后为空时回退为 book", () => {
		expect(sanitizeBookFileSegment("")).toBe("book");
		expect(sanitizeBookFileSegment("***")).toBe("book");
	});

	it("超长书名截断到 120 字符", () => {
		const long = "书".repeat(300);
		expect(sanitizeBookFileSegment(long).length).toBeLessThanOrEqual(120);
	});
});

describe("extensionForImageMimeType", () => {
	it("常见图片 MIME 映射到标准扩展名", () => {
		expect(extensionForImageMimeType("image/png")).toBe("png");
		expect(extensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(extensionForImageMimeType("image/gif")).toBe("gif");
		expect(extensionForImageMimeType("image/webp")).toBe("webp");
		expect(extensionForImageMimeType("image/svg+xml")).toBe("svg");
		expect(extensionForImageMimeType("image/avif")).toBe("avif");
		expect(extensionForImageMimeType("image/x-icon")).toBe("ico");
	});

	it("未知 image/* 按子类型推断，非图片回退 bin", () => {
		expect(extensionForImageMimeType("image/foo")).toBe("foo");
		expect(extensionForImageMimeType("application/octet-stream")).toBe("bin");
		expect(extensionForImageMimeType("")).toBe("bin");
	});
});

describe("buildImageAttachmentDir / FileName", () => {
	it("目录 = <附件根>/<净化后书名>（附件根由调用方推导传入）", () => {
		expect(buildImageAttachmentDir("三体", "CONFIG/asset")).toBe(
			"CONFIG/asset/三体",
		);
		expect(buildImageAttachmentDir("A/B:C", "CONFIG/asset")).toBe(
			"CONFIG/asset/ABC",
		);
		expect(buildImageAttachmentDir("三体", "MyData/asset")).toBe(
			"MyData/asset/三体",
		);
	});

	it("文件名 = 书名-章节-序号，序号两位补齐", () => {
		expect(buildImageAttachmentFileName("三体", 3, 1, "png")).toBe(
			"三体-3-01.png",
		);
		expect(buildImageAttachmentFileName("三体", 12, 100, "jpg")).toBe(
			"三体-12-100.jpg",
		);
	});
});

describe("buildImageNoteSuffix / buildImageNoteBlock", () => {
	it("带章节标签与时间戳", () => {
		expect(buildImageNoteSuffix(3, "第三章", "2025-01-01 12:00")).toBe(
			" [第三章] 2025-01-01 12:00",
		);
	});

	it("无章节标题时回退为「章节 N」，无时间戳时省略", () => {
		expect(buildImageNoteSuffix(3, undefined, undefined)).toBe(" [章节 3]");
	});

	it("章节标签按 chapterLabelMaxLength 截断（遵循「章节标签格式」设置）", () => {
		expect(buildImageNoteSuffix(3, "很长的章节标题名称", undefined, 4)).toBe(
			" [很长的章…]",
		);
		expect(buildImageNoteSuffix(3, "章", undefined, 4)).toBe(" [章]");
	});

	it("块文本 = 嵌入行 + 深链行；alt 作为嵌入别名（竖线被转义）", () => {
		expect(
			buildImageNoteBlock(
				"三体-3-01.png",
				"[[书.epub#cfi|书]]",
				" [章节 3]",
				"图 1",
			),
		).toBe("![[三体-3-01.png|图 1]]\n[[书.epub#cfi|书]] [章节 3]");
		expect(buildImageNoteBlock("三体-3-01.png", "[[书.epub#cfi|书]]", "")).toBe(
			"![[三体-3-01.png]]\n[[书.epub#cfi|书]]",
		);
	});
});

describe("extractImageToNote", () => {
	it("写附件并返回目录/文件名/块文本", async () => {
		const { deps, ensureDir, pathExists, writeBinary, buildDeepLink } =
			createFakeDeps();
		const result = await extractImageToNote(
			{
				bookTitle: "三体",
				chapterIndex: 3,
				chapterTitle: "第三章",
				cfi: "epubcfi(/6/2)",
				timestamp: "2025-01-01 12:00",
				alt: "恒星图",
			},
			{ bytes: PNG_BYTES, mimeType: "image/png" },
			deps,
		);

		expect(result.attachmentDir).toBe("CONFIG/asset/三体");
		expect(result.attachmentName).toBe("三体-3-01.png");
		expect(result.attachmentPath).toBe("CONFIG/asset/三体/三体-3-01.png");
		expect(ensureDir).toHaveBeenCalledWith("CONFIG/asset/三体");
		expect(writeBinary).toHaveBeenCalledWith(
			"CONFIG/asset/三体/三体-3-01.png",
			PNG_BYTES,
		);
		expect(buildDeepLink).toHaveBeenCalledWith({
			cfi: "epubcfi(/6/2)",
			chapterIndex: 3,
			chapterTitle: "第三章",
		});
		expect(result.block).toBe(
			"![[三体-3-01.png|恒星图]]\n[[书.epub#epubcfi(/6/2)|书]] [第三章] 2025-01-01 12:00",
		);
	});

	it("同名文件已存在时递增序号直到可用（允许重复提取）", async () => {
		const { deps, writeBinary } = createFakeDeps([
			"CONFIG/asset/三体/三体-3-01.png",
			"CONFIG/asset/三体/三体-3-02.png",
		]);
		const result = await extractImageToNote(
			{ bookTitle: "三体", chapterIndex: 3, cfi: "epubcfi(/6/2)" },
			{ bytes: PNG_BYTES, mimeType: "image/png" },
			deps,
		);

		expect(result.attachmentName).toBe("三体-3-03.png");
		expect(writeBinary).toHaveBeenCalledWith(
			"CONFIG/asset/三体/三体-3-03.png",
			PNG_BYTES,
		);
	});

	it("JPEG 使用 jpg 扩展名", async () => {
		const { deps, writeBinary } = createFakeDeps();
		const result = await extractImageToNote(
			{ bookTitle: "三体", chapterIndex: 1, cfi: "epubcfi(/6/1)" },
			{ bytes: PNG_BYTES, mimeType: "image/jpeg" },
			deps,
		);

		expect(result.attachmentName).toBe("三体-1-01.jpg");
		expect(writeBinary).toHaveBeenCalledWith(
			"CONFIG/asset/三体/三体-1-01.jpg",
			PNG_BYTES,
		);
	});

	it("遵循调用方传入的附件根目录", async () => {
		const { deps } = createFakeDeps();
		deps.attachmentRoot = "MyData/asset";
		const result = await extractImageToNote(
			{ bookTitle: "三体", chapterIndex: 1, cfi: "epubcfi(/6/1)" },
			{ bytes: PNG_BYTES, mimeType: "image/png" },
			deps,
		);

		expect(result.attachmentDir).toBe("MyData/asset/三体");
		expect(result.attachmentPath).toBe("MyData/asset/三体/三体-1-01.png");
	});
});
