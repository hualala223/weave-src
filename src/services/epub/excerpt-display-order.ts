/**
 * 摘录面板「排序方向」的纯逻辑（单一新测试缝）。
 *
 * 职责边界：
 * - 面板显示顺序：最新摘录在最上（默认）或最下，按 createdTime 排序；
 * - 仅影响摘录面板显示，不影响「粘贴到笔记」的写入顺序
 *   （粘贴恒为最早在最上，见 excerpt-batch-paste.ts）。
 *
 * 排序方向语义见 CONTEXT.md「摘录排序方向」。
 * 不含 Obsidian 依赖；面板只做接线。
 */

export function sortExcerptsForDisplay<T extends { createdTime?: number }>(
	items: readonly T[],
	newestOnTop: boolean,
): T[] {
	return [...items].sort((left, right) => {
		const leftTime = left.createdTime || 0;
		const rightTime = right.createdTime || 0;
		return newestOnTop ? rightTime - leftTime : leftTime - rightTime;
	});
}
