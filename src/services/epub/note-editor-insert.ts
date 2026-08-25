import type { MarkdownView } from "obsidian";

/**
 * 笔记文档编辑器插入工具（T01 预重构）。
 *
 * 把「向最近激活的 Markdown 编辑器插入块」从阅读器组件中提取为独立工具，
 * 支持两种位置：
 * - `cursor`：在当前光标处插入（文字摘录既有行为，保持不变）；
 * - `end`：追加到文档末尾（图片提取等「同步到笔记最后面」场景）。
 *
 * 依赖（resolveMarkdownView / notify）由调用方注入，便于在测试中伪造编辑器。
 */

export type NoteInsertPosition = "cursor" | "end";

export interface NoteEditorInsertDeps {
	/** 解析最近激活的 Markdown 视图（未找到时返回 null）。 */
	resolveMarkdownView: () => MarkdownView | null;
	/** 失败提示（如既有的 Notice）。 */
	notify?: (message: string) => void;
}

export interface NoteEditorInsertResult {
	ok: boolean;
	/** 插入目标笔记文档的 vault 路径；未插入时为 null。 */
	filePath: string | null;
}

export const NO_EDITOR_MESSAGE = "未找到活动的 Markdown 编辑器";

export function insertIntoMarkdownEditor(
	content: string,
	position: NoteInsertPosition,
	deps: NoteEditorInsertDeps,
): NoteEditorInsertResult {
	const view = deps.resolveMarkdownView();
	if (!view || !view.editor) {
		deps.notify?.(NO_EDITOR_MESSAGE);
		return { ok: false, filePath: null };
	}

	const editor = view.editor;
	// 追加到末尾时，若最后一行已有内容则先另起一行，避免新块与原文挤在同一行。
	const lastLine =
		position === "end" && typeof editor.getLine === "function"
			? editor.getLine(Math.max(0, editor.lineCount() - 1)) ?? ""
			: "";
	const leadingNewline = position === "end" && lastLine.trim().length > 0 ? "\n" : "";
	const cursor =
		position === "cursor"
			? editor.getCursor()
			: { line: editor.lineCount(), ch: 0 };
	editor.replaceRange(`${leadingNewline}${content}\n`, cursor);
	const lines = content.split("\n").length;
	editor.setCursor({ line: cursor.line + lines, ch: 0 });
	return { ok: true, filePath: view.file?.path ?? null };
}
