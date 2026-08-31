/**
 * 摘录相关时间戳的纯格式化（职责单一、不含 Obsidian 依赖）。
 *
 * 「划线自动插入」「想法入笔记」「粘贴所选摘录到笔记」三条输出链路共用
 * 同一时间戳模板，保证引用块内的后缀时间写法始终一致：
 * - 完整：YYYY-MM-DD HH:mm（摘录块后缀时间戳，取摘录原始创建时间）；
 * - 紧凑：MM-DD HH:mm（想法条目时间戳，截掉年份前缀）。
 */

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 完整时间戳（与划线自动插入的块后缀同款模板：YYYY-MM-DD HH:mm）。 */
export function formatExcerptTimestamp(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 紧凑时间戳（想法条目同款模板：MM-DD HH:mm）。 */
export function formatExcerptEntryTimestamp(date: Date): string {
	return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}