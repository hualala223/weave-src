import { describe, expect, it } from "vitest";
import { sortExcerptsForDisplay } from "../excerpt-display-order";

interface DisplayItem {
	id: string;
	createdTime?: number;
}

const ITEMS: DisplayItem[] = [
	{ id: "newest", createdTime: 3000 },
	{ id: "middle", createdTime: 2000 },
	{ id: "oldest", createdTime: 1000 },
];

describe("sortExcerptsForDisplay", () => {
	it("最新在最上（默认）：createdTime 降序", () => {
		expect(sortExcerptsForDisplay(ITEMS, true).map((item) => item.id)).toEqual([
			"newest",
			"middle",
			"oldest",
		]);
	});

	it("最新在最下：createdTime 升序", () => {
		expect(sortExcerptsForDisplay(ITEMS, false).map((item) => item.id)).toEqual([
			"oldest",
			"middle",
			"newest",
		]);
	});

	it("缺失时间视为 0，排在最新方向的最末端", () => {
		const items: DisplayItem[] = [
			{ id: "no-time", createdTime: undefined },
			{ id: "timed", createdTime: 1000 },
		];
		expect(sortExcerptsForDisplay(items, true).map((item) => item.id)).toEqual([
			"timed",
			"no-time",
		]);
		expect(sortExcerptsForDisplay(items, false).map((item) => item.id)).toEqual([
			"no-time",
			"timed",
		]);
	});

	it("不改动输入数组（返回新数组）", () => {
		const items: DisplayItem[] = [
			{ id: "a", createdTime: 2000 },
			{ id: "b", createdTime: 1000 },
		];
		sortExcerptsForDisplay(items, false);
		expect(items.map((item) => item.id)).toEqual(["a", "b"]);
	});
});
