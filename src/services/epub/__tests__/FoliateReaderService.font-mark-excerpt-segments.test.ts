import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "obsidian";
import { FoliateReaderService } from "../FoliateReaderService";
import type { FontMarkSegment } from "../font-mark-decoration";

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");

	class MockTFile {
		path: string;
		basename: string;
		extension: string;

		constructor(path: string) {
			this.path = path;
			const parts = path.split("/");
			const name = parts[parts.length - 1] || path;
			const dotIndex = name.lastIndexOf(".");
			this.basename = dotIndex >= 0 ? name.slice(0, dotIndex) : name;
			this.extension = dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
		}
	}

	class MockVault {
		adapter = {
			readBinary: vi.fn(async () => new ArrayBuffer(0)),
		};
		getAbstractFileByPath(path: string) {
			return new MockTFile(path);
		}
	}

	return {
		...actual,
		TFile: MockTFile,
		Vault: MockVault,
		Platform: { isDesktopApp: true },
	};
});

function createMockApp() {
	return {
		vault: {
			adapter: {
				readBinary: vi.fn(async () => new ArrayBuffer(0)),
			},
			getAbstractFileByPath: vi.fn((path: string) => {
				const basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || path;
				return { path, basename, extension: path.split(".").pop() || "" };
			}),
		} as unknown as Vault,
	} as any;
}

const EXCERPT_TEXT = "不能要太高悬赏";
const HIGHLIGHT_CFI = "epubcfi(highlight)";

/**
 * 最小帧环境（参考 comment-marker-layering 测试的伪造帧）：
 * - 每个可见帧一份独立章节 doc，正文都是同一句话；
 * - CFI 约定：划线与 `seg:<start>:<end>` 都属于 highlightSection 指定的节，
 *   解析为该节帧文本节点上的真实 DOM Range；`other:` 前缀属于异节（跨节标记）；
 *   `seg2:` 前缀为**同节第二段**（用于异段同名标记防误染场景）；
 * - 只有与节号对应的章节 doc 才解析成功——模拟真实解析器的同节约束。
 * @param secondParagraph 可选的第二段文本（同节、异段），供异段标记场景使用。
 */
function installFrameEnvironment(
	service: FoliateReaderService,
	frameSections: number[],
	highlightSection: number,
	secondParagraph?: string,
): void {
	const docsBySection = new Map<number, Document>();
	const frames = frameSections.map((sectionIndex) => {
		const doc = document.implementation.createHTMLDocument("novel");
		const paragraph = doc.createElement("p");
		paragraph.textContent = EXCERPT_TEXT;
		doc.body.appendChild(paragraph);
		if (secondParagraph !== undefined) {
			const second = doc.createElement("p");
			second.textContent = secondParagraph;
			doc.body.appendChild(second);
		}
		docsBySection.set(sectionIndex, doc);
		return {
			index: sectionIndex,
			href: `section-${sectionIndex}.xhtml`,
			frameDocument: doc,
			frameElement: null,
			frame: {
				frameDocument: doc,
				window: doc.defaultView as Window | null,
				cfiFromRange: () => null,
			},
		};
	});
	vi.spyOn(service as any, "getVisibleFramesWithIndex").mockReturnValue(frames);

	const parser = (service as any).parser;
	vi.spyOn(parser, "getSectionIndexForCfi").mockImplementation(((cfi: string) => {
		if (cfi === HIGHLIGHT_CFI || cfi.startsWith("seg:") || cfi.startsWith("seg2:")) {
			return highlightSection;
		}
		if (cfi.startsWith("other:")) {
			return highlightSection === 12 ? 13 : 12;
		}
		return null;
	}) as any);

	vi.spyOn(parser, "resolveRangeInLoadedSection").mockImplementation(
		((...args: any[]) => {
			const [cfi, doc, sectionIndex] = args as [string, Document, number];
			const makeOffsetRange = (
				paragraphIndex: number,
				start: number,
				end: number,
			): Range | null => {
				// 模拟真实解析器行为：只有与该节号对应的章节 doc 才能解析出范围。
				if (doc !== docsBySection.get(sectionIndex)) {
					return null;
				}
				const textNode = doc.body.querySelectorAll("p")[paragraphIndex]?.firstChild;
				if (!textNode) {
					return null;
				}
				const range = doc.createRange();
				range.setStart(textNode, start);
				range.setEnd(textNode, end);
				return range;
			};
			if (cfi === HIGHLIGHT_CFI) {
				return makeOffsetRange(0, 0, EXCERPT_TEXT.length);
			}
			const second = /^seg2:(\d+):(\d+)$/.exec(cfi);
			if (second) {
				return makeOffsetRange(1, Number(second[1]), Number(second[2]));
			}
			const match = /^seg:(\d+):(\d+)$/.exec(cfi);
			if (!match) {
				return null;
			}
			return makeOffsetRange(0, Number(match[1]), Number(match[2]));
		}) as any
	);
}

describe("FoliateReaderService.getExcerptFontMarkSegments（摘录导出的字色切段缝）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("同节可见帧内按 Range 精确换算多标记偏移", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			installFrameEnvironment(service, [12], 12);

			const segments = service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
				{ cfiRange: "seg:3:5", color: "red", text: "太高" },
				{ cfiRange: "seg:5:6", color: "blue", text: "悬" },
			]);

			expect(segments).toEqual<FontMarkSegment[]>([
				{ start: 3, end: 5, color: "red" },
				{ start: 5, end: 6, color: "blue" },
			]);
		} finally {
			service.destroy();
		}
	});

	it("多可见帧时选与划线同节的帧解析，而非盲取第一帧", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			// 帧 11 在前但划线在节 12；标记文本与 CFI 对应文本一致（"太高"）。
			// 只有选对帧才能通过解析 + 三路共用找回的文本验证闸、得到精确切段；
			// 选错帧（节 11）时 resolveRangeInLoadedSection 按同节约束返回 null，
			// 切段必然为空——字符串回退在任何情况下都救不回来（严格包含性）。
			installFrameEnvironment(service, [11, 12], 12);

			const segments = service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
				{ cfiRange: "seg:3:5", color: "green", text: "太高" },
			]);

			expect(segments).toEqual<FontMarkSegment[]>([{ start: 3, end: 5, color: "green" }]);
		} finally {
			service.destroy();
		}
	});

	it("跨节标记被整体排除：不做精确解析也不回退字符串匹配（防跨章误染）", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			installFrameEnvironment(service, [12], 12);

			// other: 前缀属于异节；即便其文本「太高」恰好在摘录里出现过，
			// 也不能对异节标记做字符串回退——否则他章的划线会被未落点的标记污染。
			const segments = service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
				{ cfiRange: "other:3:5", color: "gold", text: "太高" },
			]);

			expect(segments).toEqual<FontMarkSegment[]>([]);
		} finally {
			service.destroy();
		}
	});

	it("划线节解析不出时不退回当前帧节：异段同名标记不得被染进摘录（防误染）", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			installFrameEnvironment(service, [12], 12);
			// 划线 CFI 解析不出节号：无法证明任何标记与划线同节——保守放弃染色，
			// 不再借用当前可见帧的节当过滤目标（否则当前章节异段同名标记
			// 会经文本回退被染进摘录，即「没标记的词也带色」的错染根因）。
			const parser = (service as any).parser;
			vi.spyOn(parser, "getSectionIndexForCfi").mockImplementation(((cfi: string) => {
				if (cfi === HIGHLIGHT_CFI) {
					return null;
				}
				return cfi.startsWith("seg:") ? 12 : null;
			}) as any);

			const segments = service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
				{ cfiRange: "seg:3:5", color: "red", text: "太高" },
			]);

			expect(segments).toEqual<FontMarkSegment[]>([]);
		} finally {
			service.destroy();
		}
	});

	it("同节异段标记：词在摘录内多次出现时不染，唯一出现时才染（防误染唯一性闸）", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			// 同节第二段重复了摘录里的词，标记落在第二段（异段）：
			// 第一段「不能要太高悬赏」重复了「高」之外的词，这里让第二段也含「太高」。
			installFrameEnvironment(service, [12], 12, "不能要太高悬赏");

			// 标记只在第二段出现过（seg2:3:5），其词面「太高」在摘录里出现一次
			// → 唯一性闸放行：同节异段标记仍可通过文本回退染色（票 08 主场景保留）。
			const uniqueSegments = service.getExcerptFontMarkSegments(
				HIGHLIGHT_CFI,
				EXCERPT_TEXT,
				[{ cfiRange: "seg2:3:5", color: "green", text: "太高" }],
			);
			expect(uniqueSegments).toEqual<FontMarkSegment[]>([{ start: 3, end: 5, color: "green" }]);

			// 摘录文本本身重复该词（「太高」出现两次）→ 无法证明标记的是哪一处 → 不染。
			const repeatedExcerpt = "太高悬赏，太高代价";
			const repeatedSegments = service.getExcerptFontMarkSegments(
				HIGHLIGHT_CFI,
				repeatedExcerpt,
				[{ cfiRange: "broken-cfi", color: "red", text: "太高" }],
			);
			expect(repeatedSegments).toEqual<FontMarkSegment[]>([]);
		} finally {
			service.destroy();
		}
	});

	it("解析与字符串两级都失败时跳过该标记，其余标记照常生效", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			installFrameEnvironment(service, [12], 12);

			const segments = service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
				// 同节但越界偏移 → Range 解析报错返回 null；文本也不在摘录里 → 两级失败被跳过。
				{ cfiRange: "seg:99:101", color: "purple", text: "不存在的词" },
				{ cfiRange: "seg:6:7", color: "red", text: "赏" },
			]);

			expect(segments).toEqual<FontMarkSegment[]>([{ start: 6, end: 7, color: "red" }]);
		} finally {
			service.destroy();
		}
	});

	it("无可见帧/空文本/空标记一律返回空数组且不抛异常", () => {
		const service = new FoliateReaderService(createMockApp());
		try {
			// 未安装任何帧：foliateView 缺省时可见内容为空。
			expect(
				service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, EXCERPT_TEXT, [
					{ cfiRange: "seg:0:1", color: "red" },
				])
			).toEqual([]);
			expect(service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, "", [
				{ cfiRange: "seg:0:1", color: "red" },
			])).toEqual([]);

			installFrameEnvironment(service, [12], 12);
			expect(
				service.getExcerptFontMarkSegments(HIGHLIGHT_CFI, "", [
					{ cfiRange: "seg:0:1", color: "red" },
				])
			).toEqual([]);
		} finally {
			service.destroy();
		}
	});
});
