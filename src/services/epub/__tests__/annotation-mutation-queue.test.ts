import { describe, expect, it, vi } from "vitest";
import {
	AnnotationMutationQueue,
	applyFontMarkMutations,
	applyHighlightMutations,
	buildHighlightReplaceMutations,
	mergeIdeaInlineRewrite,
	isSpanFullyContained,
	normalizeAnnotationKey,
	type EpubStoredFontMark,
} from "../annotation-mutation-queue";
import type { EpubStoredHighlight } from "../schema-v2";

function hl(partial: Partial<EpubStoredHighlight> & { cfiRange: string }): EpubStoredHighlight {
	return {
		color: "yellow",
		style: "underline",
		text: "原文",
		sourceFile: "__inline__",
		sourceRef: "",
		...partial,
	} as EpubStoredHighlight;
}

function mark(partial: Partial<EpubStoredFontMark> & { cfiRange: string }): EpubStoredFontMark {
	return { color: "red", ...partial };
}

describe("mergeIdeaInlineRewrite（同 CFI 重写保留身份）", () => {
	it("沿用原划线的 excerptId 与 createdTime，想法与分隔标记原样保留", () => {
		const existing = {
			cfiRange: "epubcfi(/6/4!)",
			text: "旧文本",
			color: "yellow",
			style: "underline" as const,
			commentText: "既有想法",
			createdTime: 111,
			excerptId: "eid-stable",
		};
		const next = { cfiRange: "epubcfi(/6/4!)", text: "新文本", color: "red", style: "wavy" as const };
		const merged = mergeIdeaInlineRewrite(existing, next);
		expect(merged.excerptId).toBe("eid-stable");
		expect(merged.createdTime).toBe(111);
		expect(merged.commentText).toBe("既有想法");
		expect(merged.text).toBe("新文本");
		expect(merged.color).toBe("red");
		expect(merged.style).toBe("wavy");
	});

	it("没有既有记录时行为等同新建（生成新身份、无想法）", () => {
		const merged = mergeIdeaInlineRewrite(undefined, { cfiRange: "c", text: "T" });
		expect(merged.cfiRange).toBe("c");
		expect(merged.excerptId).toBeTruthy();
		expect(merged.commentText).toBe("");
	});
});

describe("normalizeAnnotationKey", () => {
	it("百分比编码与未编码的同义 CFI 归一为同一 key", () => {
		expect(normalizeAnnotationKey("epubcfi(/6/4!/4%5B2%5D/2)")).toBe(
			normalizeAnnotationKey("epubcfi(/6/4!/4[2]/2)")
		);
	});
});

describe("applyHighlightMutations", () => {
	it("upsert 按归一化 key 折叠重复并保留既有身份", () => {
		const items = [hl({ cfiRange: "a", excerptId: "eid-1", createdTime: 100, commentText: "旧想法" })];
		const result = applyHighlightMutations(items, [
			{ type: "upsert", record: hl({ cfiRange: "a", text: "新文本", color: "red" }) },
		]);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].excerptId).toBe("eid-1");
		expect(result.items[0].createdTime).toBe(100);
		expect(result.items[0].commentText).toBe("旧想法");
		expect(result.items[0].text).toBe("新文本");
		expect(result.items[0].color).toBe("red");
		expect(result.dropped).toBe(0);
	});

	it("upsert 相同位置（编码不同）不积累第二条", () => {
		const result = applyHighlightMutations([], [
			{ type: "upsert", record: hl({ cfiRange: "epubcfi(/6/4!/4%5B2%5D/2)" }) },
			{ type: "upsert", record: hl({ cfiRange: "epubcfi(/6/4!/4[2]/2)" }) },
		]);
		expect(result.items).toHaveLength(1);
	});

	it("remove 按归一化 key 移除全部匹配", () => {
		const items = [
			hl({ cfiRange: "epubcfi(/6/4!/4%5B2%5D/2)" }),
			hl({ cfiRange: "epubcfi(/6/4!/4[2]/2)" }),
			hl({ cfiRange: "other" }),
		];
		const result = applyHighlightMutations(items, [{ type: "remove", cfiRange: "epubcfi(/6/4!/4[2]/2)" }]);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].cfiRange).toBe("other");
	});

	it("patch 命中全部同 key 匹配并合并字段", () => {
		const items = [hl({ cfiRange: "a", color: "yellow" })];
		const result = applyHighlightMutations(items, [
			{ type: "patch", cfiRange: "a", patch: { color: "blue", style: "wavy" } },
		]);
		expect(result.items[0].color).toBe("blue");
		expect(result.items[0].style).toBe("wavy");
	});

	it("空 CFI 的 upsert 计入 dropped、不落盘；空 key 的 remove/patch 忽略", () => {
		const r1 = applyHighlightMutations([], [{ type: "upsert", record: hl({ cfiRange: "  " }) }]);
		expect(r1.items).toHaveLength(0);
		expect(r1.dropped).toBe(1);
		const r2 = applyHighlightMutations([hl({ cfiRange: "a" })], [{ type: "remove", cfiRange: "" }]);
		expect(r2.items).toHaveLength(1);
	});
});

describe("applyFontMarkMutations", () => {
	it("upsert 折叠同 key、remove 按 key 删除、patch 合并字段", () => {
		const base = applyFontMarkMutations([], [
			{ type: "upsert", record: mark({ cfiRange: "a", color: "red" }) },
			{ type: "upsert", record: mark({ cfiRange: "a", color: "blue" }) },
		]);
		expect(base.items).toHaveLength(1);
		expect(base.items[0].color).toBe("blue");
		const patched = applyFontMarkMutations(base.items, [
			{ type: "patch", cfiRange: "a", patch: { text: "词" } },
		]);
		expect(patched.items[0].text).toBe("词");
		const removed = applyFontMarkMutations(patched.items, [{ type: "remove", cfiRange: "a" }]);
		expect(removed.items).toHaveLength(0);
	});

	it("替换语义：先移除选区内既有标记、再 upsert 新标记（不叠加共存）", () => {
		// 真实数据形态：旧「别」蓝(4..5) 与 新「别具」红(4..6) 因缺替换语义重叠共存。
		const items = [
			mark({ cfiRange: "b-4-5", color: "blue", text: "别" }),
			mark({ cfiRange: "x-other", color: "green", text: "无关" }),
		];
		const replaced = applyFontMarkMutations(items, [
			{ type: "remove", cfiRange: "b-4-5" }, // 引擎报告的选区内既有标记
			{ type: "upsert", record: mark({ cfiRange: "b-4-6", color: "red", text: "别具" }) },
		]);
		expect(replaced.items).toHaveLength(2); // 无关标记不受影响
		expect(replaced.items.some((item) => item.cfiRange === "b-4-5")).toBe(false);
		expect(replaced.items.some((item) => item.cfiRange === "b-4-6")).toBe(true);
		expect(replaced.dropped).toBe(0);
	});
});

describe("AnnotationMutationQueue", () => {
	function setup(values: string[]) {
		const store = [...values];
		const load = vi.fn(async () => [...store]);
		const save = vi.fn(async (items: string[]) => {
			store.length = 0;
			store.push(...items);
		});
		const onFlush = vi.fn(async () => undefined);
		const queue = new AnnotationMutationQueue<string>({
			load,
			save,
			onFlush,
			logger: () => undefined,
		});
		return { store, load, save, onFlush, queue };
	}

	it("并发入队的变更按序串行消费，最终数组 = 各操作净效果（无丢失）", async () => {
		const { store, queue } = setup(["A", "B", "C"]);
		const pending = [
			queue.enqueue((items) => items.filter((x) => x !== "B")), // 删除 B
			queue.enqueue((items) => [...items, "D"]), // 追加 D
			queue.enqueue((items) => items.map((x) => (x === "C" ? "C2" : x))), // 改 C
		];
		await Promise.all(pending);
		expect(store).toEqual(["A", "C2", "D"]);
	});

	it("队列排干后 onFlush 恰好触发一次（刷新合并）", async () => {
		const { onFlush, queue } = setup(["A"]);
		await Promise.all([queue.enqueue((x) => x), queue.enqueue((x) => [...x, "B"])]);
		expect(onFlush).toHaveBeenCalledTimes(1);
	});

	it("单个变更失败不阻塞后续条目，并走日志", async () => {
		const store = ["A"];
		let shouldFail = true;
		const logger = vi.fn();
		const queue = new AnnotationMutationQueue<string>({
			load: async () => [...store],
			save: async (items: string[]) => {
				if (shouldFail) {
					shouldFail = false;
					throw new Error("boom");
				}
				store.length = 0;
				store.push(...items);
			},
			logger,
		});
		await queue.enqueue(() => ["B"]); // 失败：不写回
		await queue.enqueue(() => ["C"]); // 成功：写回 C
		expect(store).toEqual(["C"]); // 失败那次未写回，后续照常
		expect(logger).toHaveBeenCalledWith(expect.stringContaining("mutation failed"));
	});
});

describe("isSpanFullyContained (划线替换语义的包含判定)", () => {
	it("inner 完全落在 outer 内 → 包含", () => {
		expect(
			isSpanFullyContained({ start: 12, end: 30 }, { start: 10, end: 40 })
		).toBe(true);
	});

	it("inner 完全重合 outer → 包含", () => {
		expect(
			isSpanFullyContained({ start: 10, end: 40 }, { start: 10, end: 40 })
		).toBe(true);
	});

	it("inner 起点越出 outer → 不包含（部分重叠共存）", () => {
		expect(
			isSpanFullyContained({ start: 8, end: 30 }, { start: 10, end: 40 })
		).toBe(false);
	});

	it("inner 终点越出 outer → 不包含", () => {
		expect(
			isSpanFullyContained({ start: 12, end: 45 }, { start: 10, end: 40 })
		).toBe(false);
	});

	it("非法跨度（end < start）→ 不包含（保守）", () => {
		expect(
			isSpanFullyContained({ start: 30, end: 12 }, { start: 10, end: 40 })
		).toBe(false);
	});

	it("负坐标跨度 → 不包含（保守）", () => {
		expect(
			isSpanFullyContained({ start: -2, end: 5 }, { start: 0, end: 40 })
		).toBe(false);
	});

	it("非有限值（NaN / Infinity）→ 不包含（保守）", () => {
		expect(
			isSpanFullyContained({ start: Number.NaN, end: 30 }, { start: 10, end: 40 })
		).toBe(false);
		expect(
			isSpanFullyContained({ start: 12, end: Number.POSITIVE_INFINITY }, { start: 10, end: 40 })
		).toBe(false);
	});
});

describe("buildHighlightReplaceMutations (划线创建时替换语义)", () => {
	it("无被包含项 → 仅 upsert（与既有去重路径一致）", () => {
		const mutations = buildHighlightReplaceMutations(
			[],
			hl({ cfiRange: "new", text: "新划线" })
		);
		expect(mutations).toEqual([{ type: "upsert", record: hl({ cfiRange: "new", text: "新划线" }) }]);
	});

	it("被包含多项 → 先逐条 remove 再 upsert（顺序稳定）", () => {
		const record = hl({ cfiRange: "new", text: "新划线" });
		const mutations = buildHighlightReplaceMutations(["c1", "c2"], record);
		expect(mutations).toEqual([
			{ type: "remove", cfiRange: "c1" },
			{ type: "remove", cfiRange: "c2" },
			{ type: "upsert", record },
		]);
	});

	it("被包含项与 upsert 同 key → 不进 remove（保留身份合并路径）", () => {
		const mutations = buildHighlightReplaceMutations(
			["same", "其它"],
			hl({ cfiRange: "same", text: "重划" })
		);
		expect(mutations.filter((m) => m.type === "remove").map((m) => m.cfiRange)).toEqual(["其它"]);
	});

	it("同 key 判定按归一化 key：编码不同同义也跳过 remove", () => {
		const record = hl({ cfiRange: "epubcfi(/6/4!/4[2]/2)" });
		const mutations = buildHighlightReplaceMutations(["epubcfi(/6/4!/4%5B2%5D/2)"], record);
		expect(mutations.filter((m) => m.type === "remove")).toHaveLength(0);
	});

	it("空白被包含项被跳过", () => {
		const record = hl({ cfiRange: "new" });
		const mutations = buildHighlightReplaceMutations(["  ", "c1", ""], record);
		expect(mutations.filter((m) => m.type === "remove")).toHaveLength(1);
	});

	it("组合结果经 applyHighlightMutations 应用后：含旧身份的新划线替换被包含者", () => {
		const items = [
			hl({ cfiRange: "c1", excerptId: "eid-old", text: "旧短线" }),
			hl({ cfiRange: "keep", text: "部分重叠" }),
		];
		const record = hl({ cfiRange: "new", text: "新长线" });
		const mutations = buildHighlightReplaceMutations(["c1"], record);
		const result = applyHighlightMutations(items, mutations);
		expect(result.items.map((x) => x.cfiRange)).toEqual(["keep", "new"]);
		expect(result.dropped).toBe(0);
	});
});