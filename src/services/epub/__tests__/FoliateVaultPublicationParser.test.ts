import JSZip from "jszip";
import { TFile } from "obsidian";
import * as blobUrlText from "../../../utils/blob-url-text";
import { FoliateVaultPublicationParser } from "../FoliateVaultPublicationParser";

const { makeBookMock } = vi.hoisted(() => ({
  makeBookMock: vi.fn(),
}));

vi.mock("foliate-js/view.js", () => ({
  makeBook: makeBookMock,
}));

async function createLegacyHtmXhtmlEpubBuffer(): Promise<ArrayBuffer> {
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
    <dc:title>Legacy HTM XHTML</dc:title>
    <dc:creator>Author H</dc:creator>
    <dc:contributor opf:role="trl" xmlns:opf="http://www.idpf.org/2007/opf">Translator T</dc:contributor>
    <dc:publisher>Test Press</dc:publisher>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookID">ISBN 978-7-123-45678-9</dc:identifier>
    <dc:description>这是一段用于测试的简介。</dc:description>
    <dc:date>2024-04</dc:date>
    <dc:subject>科幻</dc:subject>
    <dc:subject>经典</dc:subject>
    <dc:rights>All rights reserved</dc:rights>
    <meta name="calibre:series" content="测试系列" />
    <meta name="price" content="¥49.00" />
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="chapter-1" href="Text/00001.htm" media-type="application/xhtml+xml" />
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter-1" />
  </spine>
</package>`
  );
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head></head>
  <docTitle><text>Legacy HTM XHTML</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="Text/00001.htm"/>
    </navPoint>
  </navMap>
</ncx>`
  );
  zip.file(
    "OEBPS/Text/00001.htm",
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-cn">
<head>
  <meta content="text/html; charset=utf-8" http-equiv="Content-Type"/>
  <title/>
</head>
<body>
  <h1 id="chapter">Chapter 1</h1>
  <p id="para">Selection text for HTM XHTML testing.</p>
</body>
</html>`
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

async function createSampleCbzBuffer(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("001.jpg", "cover");
  zip.file("002.jpg", "page");
  return zip.generateAsync({ type: "arraybuffer" });
}

function createMockApp(binary: ArrayBuffer, filePath = "Books/legacy-htm.epub") {
  const name = filePath.split("/").pop() || "book";
  const extension = name.includes(".") ? name.split(".").pop() || "" : "";
  const basename = extension ? name.slice(0, -(extension.length + 1)) : name;
  const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const file = Object.assign(Object.create(TFile.prototype), {
    path: filePath,
    name,
    basename,
    extension,
    parent: { path: parentPath },
    stat: {
      size: binary.byteLength,
      mtime: Date.now(),
      ctime: Date.now(),
    },
  });

  return {
    vault: {
      getAbstractFileByPath: () => file,
      readBinary: async () => binary,
    },
  };
}

describe("FoliateVaultPublicationParser", () => {
  afterEach(() => {
    makeBookMock.mockReset();
    vi.restoreAllMocks();
  });

  it("keeps .htm XHTML spine documents valid when OPF declares application/xhtml+xml", async () => {
    let parser: FoliateVaultPublicationParser | null = null;
    try {
      const binary = await createLegacyHtmXhtmlEpubBuffer();
      parser = new FoliateVaultPublicationParser(createMockApp(binary) as any);
      const loaded = await parser.load("Books/legacy-htm.epub");
      const doc = await parser.getBook().sections[0]?.createDocument?.();

      expect(doc).toBeTruthy();
      expect(doc?.querySelector("parsererror")).toBeNull();
      expect(doc?.documentElement.localName).toBe("html");
      expect(doc?.querySelector("#para")?.textContent).toContain(
        "Selection text for HTM XHTML testing."
      );
      expect(loaded.metadata).toMatchObject({
        title: "Legacy HTM XHTML",
        author: "Author H",
        translator: "Translator T",
        publisher: "Test Press",
        language: "zh-CN",
        identifier: "ISBN 978-7-123-45678-9",
        isbn: "9787123456789",
        description: "这是一段用于测试的简介。",
        publishDate: "2024-04",
        subjects: ["科幻", "经典"],
        series: "测试系列",
        rights: "All rights reserved",
        price: "¥49.00",
      });
    } finally {
      parser?.dispose();
    }
  });

  it("routes cbz files through foliate generic makeBook with the comic book MIME type", async () => {
    const binary = await createSampleCbzBuffer();
    const parser = new FoliateVaultPublicationParser(
      createMockApp(binary, "Books/sample.cbz") as any
    );
    const parserAny = parser as any;
    const fakeBook = {
      metadata: {
        title: "Sample CBZ",
        author: "",
      },
      toc: [],
      sections: [],
    };

    makeBookMock.mockResolvedValue(fakeBook);
    vi.spyOn(parserAny, "attachHtmlTransformPipeline").mockImplementation(() => {});
    vi.spyOn(parserAny, "buildMetadata").mockImplementation(() => {
      parserAny.metadata = {
        title: "Sample CBZ",
        author: "",
        chapterCount: 0,
        isFixedLayout: true,
      };
    });
    vi.spyOn(parserAny, "buildTocItems").mockImplementation(() => {
      parserAny.tocItems = [];
    });
    vi.spyOn(parserAny, "buildSectionDescriptors").mockResolvedValue(undefined);
    vi.spyOn(parserAny, "hydrateTocPageNumbers").mockResolvedValue(undefined);
    vi.spyOn(parserAny, "extractCoverDataUrl").mockResolvedValue(null);

    try {
      const loaded = await parser.load("Books/sample.cbz");

      expect(makeBookMock).toHaveBeenCalledTimes(1);
      const [fileArg] = makeBookMock.mock.calls[0] ?? [];
      expect(fileArg).toBeInstanceOf(File);
      expect(fileArg.name).toBe("sample.cbz");
      expect(fileArg.type).toBe("application/vnd.comicbook+zip");
      expect(loaded.fileName).toBe("sample.cbz");
      expect(loaded.metadata.title).toBe("Sample CBZ");
      expect(loaded.book).toBe(fakeBook);
    } finally {
      parser.dispose();
    }
  });

  it("loads generic MOBI sections through section.load so locator DOM matches the reader", async () => {
    const parser = new FoliateVaultPublicationParser({} as any);
    const parserAny = parser as any;
    const createDocument = vi.fn(async () => {
      const doc = document.implementation.createHTMLDocument("draft");
      doc.body.innerHTML = "<p>draft-only</p>";
      return doc;
    });
    const readerMarkup =
      '<html><head><style>blockquote{margin:0}</style></head><body><p id="reader">reader-aligned</p></body></html>';
    const load = vi.fn(async () => "blob:reader-aligned-section");
    const readBlobSpy = vi
      .spyOn(blobUrlText, "readBlobUrlAsText")
      .mockResolvedValue(readerMarkup);
    parserAny.currentBook = {
      sections: [{ id: 0, load, createDocument }],
    };
    parserAny.sectionDescriptors = [{ index: 0, href: "0", title: "Chapter 1" }];

    try {
      const doc = await parserAny.getRawDocumentFromGenericSection(0);

      expect(load).toHaveBeenCalledTimes(1);
      expect(readBlobSpy).toHaveBeenCalledWith("blob:reader-aligned-section");
      expect(createDocument).not.toHaveBeenCalled();
      expect(doc?.querySelector("#reader")?.textContent).toBe("reader-aligned");

      const cached = await parserAny.getRawDocumentFromGenericSection(0);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cached).toBe(doc);
    } finally {
      readBlobSpy.mockRestore();
    }
  });

  it("repairs foliate resolveCFI idref mismatch: index -1 is replaced by CFI-prefix section index while keeping the anchor", () => {
    // foliate Book#resolveCFI 对 idref 失配返回 { index: -1, anchor }（truthy 对象）。
    // 修复前 resolveCfiTarget 原样透传 -1，导致上层 `resolved.index === sectionIndex`
    // 判假、CFI 锚精确解析被跳过，重复短词标记掉进"节内首现"兜底。
    const parser = new FoliateVaultPublicationParser({} as any);
    const parserAny = parser as any;
    const anchor = vi.fn((doc: Document) => {
      const p = doc.querySelector("p");
      if (!p?.firstChild) return null;
      const range = doc.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, 1);
      return range;
    });
    parserAny.currentBook = {
      sections: [
        { cfi: "epubcfi(/6/12)", href: "Text/00001.htm" },
        { cfi: "epubcfi(/6/14)", href: "Text/00002.htm" },
      ],
      resolveCFI: () => ({ index: -1, anchor }),
    };

    try {
      // CFI 前缀 /6/12 应推断到 section 0（而非 -1），anchor 原样保留。
      const resolved = parserAny.resolveCfiTarget(
        "epubcfi(/6/12!/4/2,/1:0,/1:1)"
      );
      expect(resolved).not.toBeNull();
      expect(resolved.index).toBe(0);
      expect(resolved.anchor).toBe(anchor);

      const doc = document.implementation.createHTMLDocument("draft");
      doc.body.innerHTML = "<p>目标</p>";
      const range = resolved.anchor(doc);
      expect(range).not.toBeNull();
      expect(range.toString()).toBe("目");
    } finally {
      parser.dispose();
    }
  });

  it("resolves a repeated short word to its exact CFI position when the section idref mismatches (index -1)", () => {
    // 用户场景：同一页两个相同短词（如两个 B），标记第二个时被染到第一个。
    // 修复后即使 book.resolveCFI 返回 index -1，resolveCfiTarget 也恢复节号，
    // resolveRangeInLoadedSection 的 CFI 锚路径仍能精确返回第二个 B 的 Range，
    // 而不是走文本首现兜底。
    const parser = new FoliateVaultPublicationParser({} as any);
    const parserAny = parser as any;
    const doc = document.implementation.createHTMLDocument("draft");
    doc.body.innerHTML = "<p>第一段</p><p>第二段</p><p>头尾</p>";
    const secondText = doc.querySelectorAll("p")[1]!.firstChild as Text;
    const secondBRange = doc.createRange();
    secondBRange.setStart(secondText, 1);
    secondBRange.setEnd(secondText, 2);
    const anchor = vi.fn(() => secondBRange);

    parserAny.currentBook = {
      sections: [
        { cfi: "epubcfi(/6/12)", href: "Text/00001.htm" },
        { cfi: "epubcfi(/6/14)", href: "Text/00002.htm" },
      ],
      resolveCFI: () => ({ index: -1, anchor }),
    };
    parserAny.sectionDescriptors = [
      { index: 0, href: "Text/00001.htm", title: "Chapter 1" },
      { index: 1, href: "Text/00002.htm", title: "Chapter 2" },
    ];

    try {
      // 标记文本是单字 B，textHint 引述找回有 ≥4 字门槛本来就不可用，
      // 因此正确行为唯一可能是 CFI 锚精确解析（index 修复后可达）。
      const range = parserAny.resolveRangeInLoadedSection(
        "epubcfi(/6/12!/4/2,/1:1,/1:2)",
        doc,
        0,
        "B"
      );
      expect(range).not.toBeNull();
      expect(range.startContainer).toBe(secondText);
      expect(range.startOffset).toBe(1);
      expect(range.toString()).toBe("二");
    } finally {
      parser.dispose();
    }
  });
});
