/**
 * 标注存储变更串行化 —— per-book 变更队列（新接缝）。
 *
 * 删除连坐主根因是「全量读 → 变换 → 全量写」的多写者并发覆盖：多个
 * fire-and-forget 处理器各自读旧快照、各自写回，后写者胜出抹掉并发的更新。
 * 本模块把标注（划线）与字色标记的每次变更表达为**纯操作**，经每书队列
 * **串行**消费，从根上消除并发读改写竞态：
 * - apply*Mutations：纯函数「(当前数组, ops) → 新数组」，key 一律归一化 CFI；
 * - AnnotationMutationQueue：每书串行队列，消费后统一触发一次「读最新→重建」刷新
 *   （刷新合并），替代各处理器各自 fire-and-forget 的 reload。
 *
 * key 语义与引擎统一：upsert 按归一化 key 去重（同 key 折叠为一条）、
 * patch/remove 按 key 命中全部匹配（消除严格 vs 归一化 CFI 不一致导致的
 * 重复积累与误删）。空/空白 CFI 的 upsert 直接视为无效（不落盘），
 * 其它操作对空 key 忽略——沿用「无 cfiRange 即丢弃」的既有持久化行为，
 * 但通过返回 dropped 计数供上层落日志，不再无痕消失。
 *
 * 不含 Obsidian 依赖；存储/刷新回调由调用方注入。
 *
 * @module services/epub/annotation-mutation-queue
 */

import { EpubLinkService } from "./EpubLinkService";
import type { EpubStoredFontMark, EpubStoredHighlight } from "./schema-v2";

/** 划线变更操作（纯数据描述，由 applyHighlightMutations 解释）。 */
export type HighlightMutation =
	| { type: "upsert"; record: EpubStoredHighlight }
	| { type: "patch"; cfiRange: string; patch: Partial<EpubStoredHighlight> }
	| { type: "remove"; cfiRange: string };

/** 字色标记变更操作（纯数据描述，由 applyFontMarkMutations 解释）。 */
export type FontMarkMutation =
	| { type: "upsert"; record: EpubStoredFontMark }
	| { type: "patch"; cfiRange: string; patch: Partial<EpubStoredFontMark> }
	| { type: "remove"; cfiRange: string };

/** 归一化 CFI key：统一 key 语义的单一事实来源（与引擎侧 key 对齐）。 */
export function normalizeAnnotationKey(cfiRange: string): string {
	return EpubLinkService.normalizeCfi(String(cfiRange ?? "").trim());
}

function isBlank(value: string | undefined): boolean {
	return !value || !value.trim();
}

/**
 * 划线 upsert 的合并规则（对齐 mergeIdeaInlineRewrite 的身份保留）：
 * 同 key 已有记录时沿用其身份（excerptId / createdTime）与既有想法（commentText）。
 */
function mergeHighlightIdentity(
	existing: EpubStoredHighlight | undefined,
	record: EpubStoredHighlight
): EpubStoredHighlight {
	return {
		...record,
		commentText: existing?.commentText ?? record.commentText,
		hasCommentDivider: existing?.hasCommentDivider ?? record.hasCommentDivider,
		excerptId: existing?.excerptId ?? record.excerptId,
		createdTime: existing?.createdTime ?? record.createdTime,
	};
}

/** 划线变更应用结果：新数组 + 因空 CFI 被丢弃/忽略的计数（供日志）。 */
export interface HighlightMutationResult {
	items: EpubStoredHighlight[];
	dropped: number;
}

/**
 * 纯函数：按序应用划线变更到数组。
 * - upsert：按归一化 key 去重（同 key 折叠为一条、并入身份），空 CFI 计入 dropped；
 * - patch：按归一化 key 命中全部匹配并合并字段；空 key 忽略；
 * - remove：按归一化 key 移除全部匹配；空 key 忽略。
 */
export function applyHighlightMutations(
	items: EpubStoredHighlight[],
	mutations: readonly HighlightMutation[]
): HighlightMutationResult {
	let dropped = 0;
	const result = [...items];
	for (const mutation of mutations) {
		if (mutation.type === "upsert") {
			const key = normalizeAnnotationKey(mutation.record.cfiRange);
			if (isBlank(mutation.record.cfiRange)) {
				dropped += 1;
				continue;
			}
			const index = result.findIndex((item) => normalizeAnnotationKey(item.cfiRange) === key);
			const merged = mergeHighlightIdentity(index >= 0 ? result[index] : undefined, mutation.record);
			if (index >= 0) {
				result[index] = merged;
			} else {
				result.push(merged);
			}
			continue;
		}
		const key = normalizeAnnotationKey(mutation.cfiRange);
		if (isBlank(mutation.cfiRange)) {
			continue;
		}
		if (mutation.type === "remove") {
			for (let i = result.length - 1; i >= 0; i -= 1) {
				if (normalizeAnnotationKey(result[i].cfiRange) === key) {
					result.splice(i, 1);
				}
			}
			continue;
		}
		// patch
		for (const item of result) {
			if (normalizeAnnotationKey(item.cfiRange) === key) {
				Object.assign(item, mutation.patch);
			}
		}
	}
	return { items: result, dropped };
}

/** 字色标记变更应用结果：新数组 + 因空 CFI 被丢弃/忽略的计数（供日志）。 */
export interface FontMarkMutationResult {
	items: EpubStoredFontMark[];
	dropped: number;
}

/** 纯函数：按序应用字色标记变更到数组（语义同划线，仅形状不同）。 */
export function applyFontMarkMutations(
	items: EpubStoredFontMark[],
	mutations: readonly FontMarkMutation[]
): FontMarkMutationResult {
	let dropped = 0;
	const result = [...items];
	for (const mutation of mutations) {
		if (mutation.type === "upsert") {
			const key = normalizeAnnotationKey(mutation.record.cfiRange);
			if (isBlank(mutation.record.cfiRange)) {
				dropped += 1;
				continue;
			}
			const index = result.findIndex((item) => normalizeAnnotationKey(item.cfiRange) === key);
			if (index >= 0) {
				result[index] = { ...result[index], ...mutation.record, id: result[index].id ?? mutation.record.id };
			} else {
				result.push(mutation.record);
			}
			continue;
		}
		const key = normalizeAnnotationKey(mutation.cfiRange);
		if (isBlank(mutation.cfiRange)) {
			continue;
		}
		if (mutation.type === "remove") {
			for (let i = result.length - 1; i >= 0; i -= 1) {
				if (normalizeAnnotationKey(result[i].cfiRange) === key) {
					result.splice(i, 1);
				}
			}
			continue;
		}
		for (const item of result) {
			if (normalizeAnnotationKey(item.cfiRange) === key) {
				Object.assign(item, mutation.patch);
			}
		}
	}
	return { items: result, dropped };
}

export interface AnnotationMutationQueueOptions<T> {
	/** 读当前数组（全量）。 */
	load: () => Promise<T[]>;
	/** 写回新数组（整组覆盖，由本队列串行调用）。 */
	save: (items: T[]) => Promise<void>;
	/** 每次写回成功后的「读最新→重建」回调（刷新合并：一轮排干末尾触发一次）。 */
	onFlush?: (items: T[]) => void | Promise<void>;
	/** 丢弃/异常日志口（默认静默）。 */
	logger?: (message: string) => void;
}

/**
 * 每书串行变更队列：enqueue 立即返回，mutation 按入队顺序逐个消费，
 * 消费失败不阻塞后续条目（记日志）；每次队列排干后统一触发一次 onFlush。
 */
export class AnnotationMutationQueue<T> {
	private readonly tasks: { run: () => Promise<T[] | undefined> }[] = [];
	private running = false;
	private readonly load: () => Promise<T[]>;
	private readonly save: (items: T[]) => Promise<void>;
	private readonly onFlush?: (items: T[]) => void | Promise<void>;
	private readonly logger: (message: string) => void;

	constructor(options: AnnotationMutationQueueOptions<T>) {
		this.load = options.load;
		this.save = options.save;
		this.onFlush = options.onFlush;
		this.logger = options.logger ?? (() => undefined);
	}

	/** 入队一个变更；返回的 Promise 在该变更消费完成后 resolve。 */
	enqueue(apply: (items: T[]) => T[]): Promise<void> {
		return new Promise<void>((resolve) => {
			this.tasks.push({
				run: async () => {
					try {
						const items = await this.load();
						const next = apply(items);
						await this.save(next);
						resolve();
						return next;
					} catch (error) {
						this.logger(`[AnnotationMutationQueue] mutation failed: ${String(error)}`);
						resolve();
						return undefined;
					}
				},
			});
			void this.drain();
		});
	}

	/**
	 * 在队列串行边界内执行一次「变换」（迁移既有同步路径用）；同一轮排干末尾触发一次 onFlush。
	 */
	run(apply: (items: T[]) => T[]): Promise<T[]> {
		return new Promise<T[]>((resolve) => {
			this.tasks.push({
				run: async () => {
					try {
						const items = await this.load();
						const next = apply(items);
						await this.save(next);
						resolve(next);
						return next;
					} catch (error) {
						this.logger(`[AnnotationMutationQueue] run failed: ${String(error)}`);
						resolve([]);
						return undefined;
					}
				},
			});
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			let lastFlush: T[] | undefined;
			while (this.tasks.length) {
				const task = this.tasks.shift();
				if (!task) {
					break;
				}
				const next = await task.run();
				if (next !== undefined) {
					lastFlush = next;
				}
			}
			// 刷新合并：一轮排干末端触发一次「读最新→重建」。
			if (lastFlush !== undefined && this.onFlush) {
				await this.onFlush(lastFlush);
			}
		} finally {
			this.running = false;
		}
	}
}