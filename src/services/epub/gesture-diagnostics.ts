/**
 * 阅读手势诊断记录器（临时调试工具）。
 *
 * 记录移动端阅读手势（touch / selection / 翻页 / 滚动）的关键事件到内存环形缓冲，
 * 供导出到 vault 文件，用于排查「拖动选区光标闪跳」等问题。
 * 完成排查后，本文件及所有 recordGesture* 调用点可整体删除。
 */

export interface GestureDiagEntry {
	t: number;
	label: string;
	detail: string;
}

const MAX_ENTRIES = 2000;
const entries: GestureDiagEntry[] = [];

function nowTime(): string {
	const d = new Date();
	return (
		d.toISOString().substring(11, 23) +
		"." +
		String(d.getMilliseconds()).padStart(3, "0")
	);
}

function safeStringify(value: unknown): string {
	try {
		if (typeof value === "string") {
			return value;
		}
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** 清空诊断缓冲（例如阅读会话切换时）。 */
export function resetGestureDiag(): void {
	entries.length = 0;
}

/** 记录一条手势诊断事件（带时间戳，保留最近 MAX_ENTRIES 条）。 */
export function recordGesture(label: string, detail?: unknown): void {
	entries.push({ t: performance.now(), label, detail: safeStringify(detail) });
	if (entries.length > MAX_ENTRIES) {
		entries.shift();
	}
}

/** 导出诊断缓冲为纯文本（最近在前）。 */
export function gestureDiagDump(): string {
	return entries
		.map((entry) => `[${nowTime()}] ${entry.label} ${entry.detail}`)
		.join("\n");
}

/** 缓冲当前条数。 */
export function gestureDiagCount(): number {
	return entries.length;
}

/** 选区摘要（供日志/诊断用，避免依赖 jsdom 的 Selection 实现）。 */
export function selectionDesc(doc: Document | null | undefined): string {
	const sel = doc?.getSelection?.();
	if (!sel) {
		return "sel=null";
	}
	return `sel={rangeCount:${sel.rangeCount},collapsed:${sel.isCollapsed},type:${sel.type}}`;
}