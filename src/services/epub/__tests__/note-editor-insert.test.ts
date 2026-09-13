import { describe, expect, it, vi } from "vitest";
import type { Editor, MarkdownView } from "obsidian";
import {
	insertIntoMarkdownEditor,
	type NoteEditorInsertResult,
} from "../note-editor-insert";

interface ReplaceCall {
	replacement: string;
	from: { line: number; ch: number };
}

function createFakeEditor(
	initialCursor = { line: 1, ch: 4 },
	lineCount = 5,
	lines?: string[],
): {
	editor: Editor;
	replaceCalls: ReplaceCall[];
	setCursorCalls: Array<{ line: number; ch: number }>;
} {
	const replaceCalls: ReplaceCall[] = [];
	const setCursorCalls: Array<{ line: number; ch: number }> = [];
	const docLines = lines ?? Array.from({ length: lineCount }, () => "");
	const editor = {
		getCursor: () => ({ ...initialCursor }),
		setCursor: (pos: { line: number; ch: number }) => {
			setCursorCalls.push({ ...pos });
		},
		lineCount: () => docLines.length,
		getLine: (line: number) => docLines[line] ?? "",
		replaceRange: (replacement: string, from: { line: number; ch: number }) => {
			replaceCalls.push({ replacement, from: { ...from } });
		},
	} as unknown as Editor;
	return { editor, replaceCalls, setCursorCalls };
}

function createFakeView(editor: Editor, path = "Notes.md"): MarkdownView {
	return { editor, file: { path } } as unknown as MarkdownView;
}

describe("insertIntoMarkdownEditor", () => {
	it("在光标模式下于当前光标处插入内容并下移光标（与既有文字摘录行为一致）", () => {
		const { editor, replaceCalls, setCursorCalls } = createFakeEditor({
			line: 1,
			ch: 4,
		});
		const result = insertIntoMarkdownEditor("> 引文\n", "cursor", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(result).toEqual<NoteEditorInsertResult>({
			ok: true,
			filePath: "Notes.md",
		});
		expect(replaceCalls).toEqual([
			{ replacement: "> 引文\n\n", from: { line: 1, ch: 4 } },
		]);
		expect(setCursorCalls.at(-1)).toEqual({ line: 3, ch: 0 });
	});

	it("文末模式下无论光标在哪都插入到文档末尾", () => {
		const { editor, replaceCalls } = createFakeEditor({ line: 1, ch: 4 }, 9);
		const result = insertIntoMarkdownEditor("![[img.png]]\n", "end", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(result).toEqual<NoteEditorInsertResult>({
			ok: true,
			filePath: "Notes.md",
		});
		expect(replaceCalls).toEqual([
			{ replacement: "![[img.png]]\n\n", from: { line: 0, ch: 0 } },
		]);
	});

	it("文末模式且最后一行非空时，先空一行再追加（连续粘贴的块之间有空行分隔）", () => {
		const { editor, replaceCalls, setCursorCalls } = createFakeEditor(
			{ line: 0, ch: 0 },
			1,
			["已有内容"],
		);
		const result = insertIntoMarkdownEditor("> 新摘录\n", "end", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(result.ok).toBe(true);
		expect(replaceCalls).toEqual([
			{ replacement: "\n> 新摘录\n\n", from: { line: 0, ch: 4 } },
		]);
		expect(setCursorCalls.at(-1)).toEqual({ line: 3, ch: 0 });
	});

	it("文末模式且文档以一个空行收尾时，保留该空行作分隔、不堆多余空行", () => {
		const { editor, replaceCalls } = createFakeEditor(
			{ line: 0, ch: 0 },
			2,
			["旧内容", ""],
		);
		insertIntoMarkdownEditor("> 新摘录\n", "end", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(replaceCalls).toEqual([
			{ replacement: "\n> 新摘录\n\n", from: { line: 1, ch: 0 } },
		]);
	});

	it("文末模式且文档以多个空行收尾时，归一化为恰好一个空行分隔", () => {
		const { editor, replaceCalls } = createFakeEditor(
			{ line: 0, ch: 0 },
			3,
			["旧内容", "", ""],
		);
		insertIntoMarkdownEditor("> 新摘录\n", "end", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(replaceCalls).toEqual([
			{ replacement: "\n> 新摘录\n\n", from: { line: 1, ch: 0 } },
		]);
	});

	it("内容以换行结尾时仍追加一个换行（保持与既有摘录一致的空行分隔）", () => {
		const { editor, replaceCalls } = createFakeEditor({ line: 0, ch: 0 });
		insertIntoMarkdownEditor("块内容\n", "cursor", {
			resolveMarkdownView: () => createFakeView(editor),
		});

		expect(replaceCalls).toEqual([
			{ replacement: "块内容\n\n", from: { line: 0, ch: 0 } },
		]);
	});

	it("没有可用的 MD 编辑器时通知用户且不产生任何写入", () => {
		const notify = vi.fn();
		const { editor, replaceCalls } = createFakeEditor();
		const result = insertIntoMarkdownEditor("内容", "end", {
			resolveMarkdownView: () => null,
			notify,
		});

		expect(result).toEqual<NoteEditorInsertResult>({
			ok: false,
			filePath: null,
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("未找到活动的 Markdown 编辑器");
		expect(replaceCalls).toHaveLength(0);
	});
});
