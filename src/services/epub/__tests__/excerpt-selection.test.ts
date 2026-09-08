import { describe, expect, it } from "vitest";
import {
	isSameLocalCalendarDay,
	selectTodayExcerpts,
	selectUnpastedExcerpts,
} from "../excerpt-selection";

interface SelectionItem {
	id: string;
	createdTime?: number;
	pastedAt?: number;
}

// 固定「今天」：2026-09-08 15:30 本地时间。
const NOW = new Date(2026, 8, 8, 15, 30).getTime();

describe("isSameLocalCalendarDay", () => {
	it("同一本地自然日的两个时刻为真（跨小时）", () => {
		const morning = new Date(2026, 8, 8, 0, 5).getTime();
		expect(isSameLocalCalendarDay(morning, NOW)).toBe(true);
	});

	it("昨天/明天为假（以本地时区边界判定，非 24 小时滚动窗口）", () => {
		const yesterday = new Date(2026, 8, 7, 23, 59).getTime();
		const tomorrow = new Date(2026, 8, 9, 0, 1).getTime();
		expect(isSameLocalCalendarDay(yesterday, NOW)).toBe(false);
		expect(isSameLocalCalendarDay(tomorrow, NOW)).toBe(false);
	});

	it("缺失/非法时间（0、负数、NaN）为假", () => {
		expect(isSameLocalCalendarDay(0, NOW)).toBe(false);
		expect(isSameLocalCalendarDay(-1, NOW)).toBe(false);
		expect(isSameLocalCalendarDay(Number.NaN, NOW)).toBe(false);
	});
});

describe("selectTodayExcerpts", () => {
	it("只保留今天创建的条目（本地自然日）", () => {
		const items: SelectionItem[] = [
			{ id: "today-early", createdTime: new Date(2026, 8, 8, 0, 1).getTime() },
			{ id: "yesterday", createdTime: new Date(2026, 8, 7, 22, 0).getTime() },
			{ id: "today-late", createdTime: new Date(2026, 8, 8, 15, 0).getTime() },
		];
		expect(selectTodayExcerpts(items, NOW).map((item) => item.id)).toEqual([
			"today-early",
			"today-late",
		]);
	});

	it("缺失/非法 createdTime 的条目不入选", () => {
		const items: SelectionItem[] = [
			{ id: "no-time" },
			{ id: "zero", createdTime: 0 },
		];
		expect(selectTodayExcerpts(items, NOW)).toEqual([]);
	});

	it("不修改原数组", () => {
		const items: SelectionItem[] = [
			{ id: "a", createdTime: NOW },
			{ id: "b", createdTime: 1 },
		];
		selectTodayExcerpts(items, NOW);
		expect(items).toHaveLength(2);
	});
});

describe("selectUnpastedExcerpts", () => {
	it("只保留无已粘贴标记的条目（字段缺省 = 未粘贴）", () => {
		const items: SelectionItem[] = [
			{ id: "unpasted" },
			{ id: "pasted", pastedAt: NOW },
			{ id: "pasted-earlier", pastedAt: 1000 },
		];
		expect(selectUnpastedExcerpts(items).map((item) => item.id)).toEqual([
			"unpasted",
		]);
	});
});
