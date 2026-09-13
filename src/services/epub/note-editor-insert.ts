import type { MarkdownView } from "obsidian";
import { perfBegin, perfEnd } from "../../utils/perf-probe";

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
	const insertProbeStart = perfBegin();
	// 追加到末尾时与既有内容保持「恰好一个空行分隔」：先把文档末尾的所有尾随空行
	// （0 个或多个）连同旧内容边界一起，归一化重写为恰好一个空行，再接新内容。
	// 只看末行是否为空不够——上次追加留下的那个空行会被本次内容原位填掉，等于没有分隔。
	const hasLineAccess = typeof editor.getLine === "function";
	const total = editor.lineCount();
	let lastNonEmpty = total - 1;
	if (position === "end" && hasLineAccess) {
		while (lastNonEmpty >= 0 && (editor.getLine(lastNonEmpty) ?? "").trim().length === 0) {
			lastNonEmpty -= 1;
		}
	}
	const replaceEnd = { line: total - 1, ch: (editor.getLine(total - 1) ?? "").length };
	// 尾随空行区的起点；最后一行本身有内容时（lastNonEmpty === total-1）没有可复用的
	// 空行区，插入锚点显式取文档最末字符之后，不依赖编辑器对越界位置的钳制行为。
	const replaceStart =
		lastNonEmpty + 1 <= total - 1
			? { line: lastNonEmpty + 1, ch: 0 }
			: { line: total - 1, ch: replaceEnd.ch };
	const cursor =
		position === "cursor"
			? editor.getCursor()
			: replaceStart;
	const separator = position === "end" && lastNonEmpty >= 0 ? "\n" : "";
	const replacement =
		position === "end" && hasLineAccess
			? `${separator}${content}\n`
			: `${content}\n`;
	const replaceTo = position === "end" && hasLineAccess ? replaceEnd : undefined;
	editor.replaceRange(replacement, cursor, replaceTo);
	// 光标移到插入文本的末行（按实际写入的完整文本统计行数，含前导空行与收尾换行）。
	const lines = replacement.split("\n").length - 1;
	editor.setCursor({ line: cursor.line + lines, ch: 0 });
	perfEnd("insertIntoMarkdownEditor", insertProbeStart, {
		always: true,
		extra: { lines: total, position, bytes: content.length },
	});
	return { ok: true, filePath: view.file?.path ?? null };
}
