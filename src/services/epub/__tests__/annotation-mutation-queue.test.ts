import { describe, expect, it, vi } from "vitest";
import {
	AnnotationMutationQueue,
	applyFontMarkMutations,
	applyHighlightMutations,
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