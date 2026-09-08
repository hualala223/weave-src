/**
 * 摘录面板「快捷圈定」的纯逻辑（单一新测试缝）。
 *
 * 职责边界：
 * - 圈定谓词：今日摘录（createdTime 的本地自然日 = 今天，注入当前时刻以便测试）、
 *   未粘贴摘录（无已粘贴标记；旧记录缺字段 = 未粘贴）；
 * - 「已粘贴」标记本身的回写走宿主的既有划线变更队列（按 cfiRange patch 落盘），
 *   属宿主胶水，不在本纯函数缝内。
 *
 * 纯谓词与筛选标记语义，见 CONTEXT.md「今日摘录」「已粘贴」。
 * 不含 Obsidian 依赖；面板只做接线。
 */

/** 判断两个时刻是否属于同一个本地自然日（本地时区，非 UTC）。 */
export function isSameLocalCalendarDay(left: number, right: number): boolean {
	if (
		!Number.isFinite(left) ||
		!Number.isFinite(right) ||
		left <= 0 ||
		right <= 0
	) {
		return false;
	}
	const leftDate = new Date(left);
	const rightDate = new Date(right);
	return (
		leftDate.getFullYear() === rightDate.getFullYear() &&
		leftDate.getMonth() === rightDate.getMonth() &&
		leftDate.getDate() === rightDate.getDate()
	);
}

/** 「选中今日摘录」：createdTime 落在今天（本地自然日）的条目；缺失/非法时间不入选。 */
export function selectTodayExcerpts<T extends { createdTime?: number }>(
	items: readonly T[],
	now: number,
): T[] {
	return items.filter((item) =>
		isSameLocalCalendarDay(item.createdTime || 0, now),
	);
}

/** 「选中未粘贴摘录」：无已粘贴标记的条目（字段缺省 = 未粘贴，向后兼容）。 */
export function selectUnpastedExcerpts<T extends { pastedAt?: number }>(
	items: readonly T[],
): T[] {
	return items.filter((item) => !item.pastedAt);
}
