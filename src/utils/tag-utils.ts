/** 标签筛选和聚合工具。 */

import { extractAllTags } from "./yaml-utils";
import type { Card } from "../data/types";

/** 规范化标签前缀，统一返回不含 `#` 的形式。 */
export function removeHashPrefix(tag: string): string {
	return tag.startsWith("#") ? tag.slice(1) : tag;
}

type TagSourceDataType = "memory" | "questionBank" | "incremental-reading";

export function getCardTagValues(card: Card, dataSourceType: TagSourceDataType = "memory"): string[] {
	const normalized = new Set<string>();
	const values: string[] = [];

	const pushValues = (candidateValues: unknown[]) => {
		for (const value of candidateValues) {
			if (typeof value !== "string") continue;
			const normalizedValue = value.trim();
			if (!normalizedValue || normalized.has(normalizedValue)) continue;
			normalized.add(normalizedValue);
			values.push(normalizedValue);
		}
	};

	if (dataSourceType === "incremental-reading") {
		pushValues(Array.isArray(card.ir_tags) ? card.ir_tags : []);
	}

	pushValues(extractAllTags(card.content || ""));
	pushValues(Array.isArray(card.tags) ? card.tags : []);

	return values;
}

