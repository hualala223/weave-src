import JSZip from "jszip";
import { TFile } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import { createEpubReaderEngine } from "../reader-engine-factory";
import { ExcerptParagraphPreviewService } from "../excerpt-paragraph-preview-service";

async function createSampleEpubBuffer(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`
	);
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Repro</dc:title><dc:creator>A</dc:creator><dc:language>zh-CN</dc:language>
    <dc:identifier id="BookID">id-1</dc:identifier>
  </metadata>
  <manifest><item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml" /></manifest>
  <spine><itemref idref="c1" /></spine>
</package>`
	);
	zip.file(
		"OEBPS/Text/c1.xhtml",
		`<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head>
<body><h1>第一章</h1><p>窗外的雨下个不停，屋檐滴水成线。他望着远方出神。</p><p>第二段内容。</p></body></html>`
	);
	return zip.generateAsync({ type: "arraybuffer" });
}

function createMockApp(binary: ArrayBuffer, filePath = "Books/repro.epub") {
	const name = filePath.split("/").pop() || "book";
	const extension = name.split(".").pop() || "";
	const basename = name.slice(0, -(extension.length + 1));
	const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
	const file = Object.assign(Object.create(TFile.prototype), {
		path: filePath,
		name,
		basename,
		extension,
		parent: { path: parentPath },
		stat: { size: binary.byteLength, mtime: Date.now(), ctime: Date.now() },
	});
	return {
		vault: {
			getAbstractFileByPath: () => file,
			readBinary: async () => binary,
		},
	};
}

describe("detached engine paragraph preview (real foliate engine, no view)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loadEpub 无视图可用；真实 CFI 可解析章节与段落；坏 CFI 走兜底也能命中", async () => {
		const binary = await createSampleEpubBuffer();
		const engine = createEpubReaderEngine(createMockApp(binary) as any);
		try {
			await engine.loadEpub("Books/repro.epub");

			// 真实形状 CFI（foliate 从 Range 生成，与划线 cfiRange 同源）可定位章节与段落。
			const processedDoc = await (engine as any).parser.getProcessedDocumentByIndex(0);
			const pEl = processedDoc?.querySelectorAll("p")[0];
			expect(pEl).toBeTruthy();
			const range = processedDoc.createRange();
			range.selectNodeContents(pEl);
			const realCfi: string = await (engine as any).parser.createCfiFromRange(0, range);
			const realIndex = await engine.getSectionIndexForCfi?.(realCfi);
			expect(typeof realIndex === "number" && realIndex >= 0).toBe(true);
			const paragraphs =
				typeof realIndex === "number"
					? await engine.getParagraphsForChapter(realIndex, { includeHtml: false })
					: [];
			expect(paragraphs.length).toBeGreaterThan(0);

			// 预览服务对解析不出来的手写 CFI 也能经兜底层命中（文本纠偏/邻居/全书扫描）。
			const service = new ExcerptParagraphPreviewService(createMockApp(binary) as any);
			try {
				const preview = await service.getPreview({
					filePath: "Books/repro.epub",
					cfi: "epubcfi(/6/4!/4/2,/1:0,/1:10)",
					excerptText: "雨下个不停",
				});
				expect(preview.status).toBe("found");
				expect(preview.paragraphText).toContain("雨下个不停");
				expect(preview.highlight).not.toBeNull();
			} finally {
				service.dispose();
			}
		} finally {
			engine.destroy();
		}
	}, 30000);
});
