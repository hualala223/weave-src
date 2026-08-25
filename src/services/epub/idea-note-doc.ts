/**
 * 想法入笔记 —— 文档变换纯服务（唯一新接缝）。
 *
 * 对「笔记文档全文文本」做纯文本进/出的变换：
 * - 渲染带 💡 想法条目的摘录块（原文与想法同块、空引用行分隔）；
 * - 按划线标识（eid）优先、CFI 兜底在文档中定位既有摘录块；
 * - upsert 五态语义：created / appended / replaced / stripped / noop。
 *
 * 不含任何 Obsidian 依赖；补丁以编辑器行/列位置表达，调用方直接喂给
 * 编辑器的 replaceRange。
 *
 * @module services/epub/idea-note-doc
 */

import { EpubLinkService } from "./EpubLinkService";
import { generateBlockID } from "../identifier/WeaveIDGenerator";
import type { ReaderHighlight } from "./reader-engine-types";
import type { EpubHighlightStyle } from "./types";

/** 条目标签（裸灯泡，无加粗、无标签文字），后接可选的紧凑时间戳。 */
export const IDEA_ENTRY_LABEL = "💡";

export type IdeaNoteOutcome = "created" | "appended" | "replaced" | "stripped" | "noop";

/** 一条想法条目的输入：想法正文 + 写入时刻（紧凑 MM-DD HH:mm）。 */
export interface IdeaEntryInput {
	text: string;
	timestamp?: string;
}

export interface IdeaEditorPosition {
	line: number;
	ch: number;
}

/** 面向编辑器 replaceRange 的最小补丁。 */
export interface IdeaBlockPatch {
	from: IdeaEditorPosition;
	to: IdeaEditorPosition;
	text: string;
}

export interface IdeaNoteResult {
	outcome: IdeaNoteOutcome;
	doc: string;
	patch?: IdeaBlockPatch;
	/** 去重删除的附加补丁（按文档从后往前的顺序，应用时应最后处理）。 */
	extraPatches?: IdeaBlockPatch[];
	/** 同步后的完整块文本（无活动编辑器兜底复制用；created 必有，其余视路径）。 */
	block?: string;
}

/** 块身份：深链中的稳定划线标识优先，无标识历史块用 CFI 兜底。 */
export interface IdeaBlockIdentity {
	eid?: string;
	cfi?: string;
}

/** 同 CFI 重写时的新值（仅文本/颜色/样式位）。 */
export interface IdeaInlineRewriteInput {
	cfiRange: string;
	text: string;
	color?: string;
	style?: EpubHighlightStyle;
}

/** 合并后的记录：沿用原身份与既有想法，更新文本/样式位。复用划线记录的字段形状。 */
export type IdeaMergedInlineRecord = Pick<
	ReaderHighlight,
	"cfiRange" | "text" | "color" | "style" | "commentText" | "createdTime" | "excerptId"
>;

/**
 * 同 CFI 重写合并规则（配套修复）：对同一句再次选字时，
 * 不抹掉旧记录——沿用原 excerptId 与 createdTime、保留既有想法；
 * 没有旧记录则等价新建（新身份、空想法）。
 */
export function mergeIdeaInlineRewrite(
	existing: Partial<IdeaMergedInlineRecord> | undefined,
	next: IdeaInlineRewriteInput
): IdeaMergedInlineRecord {
	const now = Date.now();
	return {
		cfiRange: next.cfiRange,
		text: next.text,
		color: next.color || existing?.color || "",
		style: next.style || existing?.style,
		commentText: existing?.commentText || "",
		createdTime: existing?.createdTime || now,
		excerptId: existing?.excerptId || generateBlockID(),
	};
}

function decodeUriComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function offsetToPos(doc: string, offset: number): IdeaEditorPosition {
	const before = doc.slice(0, offset);
	const line = (before.match(/\n/g) || []).length;
	const lastBreak = before.lastIndexOf("\n");
	return { line, ch: offset - (lastBreak + 1) };
}

function lineStartOffsets(doc: string): number[] {
	const offsets = [0];
	for (let i = 0; i < doc.length; i += 1) {
		if (doc[i] === "\n") {
			offsets.push(i + 1);
		}
	}
	return offsets;
}

function offsetOf(doc: string, pos: IdeaEditorPosition): number {
	return lineStartOffsets(doc)[pos.line] + pos.ch;
}

function isCalloutLine(line: string): boolean {
	return line.trimStart().startsWith(">");
}

/** 从块首行提取 `[[路径#子路径|别名]]` 的子路径部分。 */
function extractLocatorSubpath(headerLine: string): string {
	const inner = headerLine.match(/\[\[([^\]]+)\]\]/)?.[1];
	if (!inner) {
		return "";
	}
	const hashIdx = inner.indexOf("#");
	if (hashIdx === -1) {
		return "";
	}
	return inner.slice(hashIdx + 1).split("|")[0] || "";
}

function readExcerptIdFromSubpath(subpath: string): string | null {
	const match = subpath.match(/(?:^|[&?])eid=([^&|\]]*)/);
	return match ? decodeUriComponentSafe(match[1]) : null;
}

function identityMatchesBlock(identity: IdeaBlockIdentity, headerLine: string): boolean {
	const subpath = extractLocatorSubpath(headerLine);
	if (!subpath) {
		return false;
	}
	if (identity.eid) {
		const blockEid = readExcerptIdFromSubpath(subpath);
		if (blockEid && blockEid.trim() === identity.eid.trim()) {
			return true;
		}
		// eid 失配时若身份还带 CFI，允许 CFI 兜底（同句合并规则的定位基础）。
		if (!identity.cfi) {
			return false;
		}
	}
	if (identity.cfi) {
		let parsedCfi: string | undefined;
		try {
			parsedCfi = EpubLinkService.parseEpubLink(`#${subpath}`)?.cfi;
		} catch {
			parsedCfi = undefined;
		}
		if (parsedCfi) {
			return parsedCfi.trim() === identity.cfi.trim();
		}
		return decodeUriComponentSafe(subpath).includes(identity.cfi.trim());
	}
	return false;
}

/** 定位文档中所有身份匹配的摘录块（`> [!EPUB` 开头的连续引用行），按文档顺序。 */
function locateAllIdeaQuoteBlocks(
	doc: string,
	identity: IdeaBlockIdentity
): { start: IdeaEditorPosition; end: IdeaEditorPosition }[] {
	if (!identity.eid && !identity.cfi) {
		return [];
	}
	const hits: { start: IdeaEditorPosition; end: IdeaEditorPosition }[] = [];
	const lines = doc.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const trimmed = lines[i].trimStart();
		if (!trimmed.startsWith("> [!EPUB")) {
			continue;
		}
		let end = i;
		while (end + 1 < lines.length && isCalloutLine(lines[end + 1])) {
			end += 1;
		}
		if (identityMatchesBlock(identity, lines[i])) {
			hits.push({
				start: { line: i, ch: lines[i].length - trimmed.length },
				end: { line: end, ch: lines[end].length },
			});
		}
		i = end;
	}
	return hits;
}

/**
 * 定位文档中身份匹配的摘录块（`> [!EPUB` 开头的连续引用行）。
 * 找不到返回 null。
 */
export function locateIdeaQuoteBlock(
	doc: string,
	identity: IdeaBlockIdentity
): { start: IdeaEditorPosition; end: IdeaEditorPosition } | null {
	return locateAllIdeaQuoteBlocks(doc, identity)[0] ?? null;
}

function renderEntryLines(entry: IdeaEntryInput): string[] {
	const label = entry.timestamp ? `${IDEA_ENTRY_LABEL} ${entry.timestamp}` : IDEA_ENTRY_LABEL;
	const bodyLines = String(entry.text ?? "").split("\n");
	return [`> ${label}`, ...bodyLines.map((line) => `> ${line}`)];
}

const IDEA_LABEL_LINE_RE = /^>\s*(?:\*\*💡 想法：\*\*|💡)(?:\s+([0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}))?/;

/**
 * 解析块内已存在的想法条目（按顺序，含时间戳）。空引用行（`>`）分隔条目，
 * 首个条目之前的空白引用行不计。无法识别的块视为无条目。
 */
function parseIdeaEntryGroups(blockText: string): IdeaEntryInput[] {
	const entries: IdeaEntryInput[] = [];
	let current: string[] | null = null;
	const timestampOf = (line: string) => line.match(IDEA_LABEL_LINE_RE)?.[1] ?? undefined;
	let currentTimestamp: string | undefined;
	const finalize = () => {
		if (current !== null) {
			const text = current.join("\n").trim();
			if (text) {
				entries.push({ text, timestamp: currentTimestamp });
			}
			current = null;
			currentTimestamp = undefined;
		}
	};
	for (const line of blockText.split("\n")) {
		if (IDEA_LABEL_LINE_RE.test(line)) {
			finalize();
			current = [];
			currentTimestamp = timestampOf(line);
			continue;
		}
		if (!line.trimStart().startsWith(">")) {
			finalize();
			continue;
		}
		if (line.trim() === ">") {
			finalize();
			continue;
		}
		if (current !== null) {
			current.push(line.replace(/^>\s?/, ""));
		}
	}
	finalize();
	return entries;
}

/**
 * 解析块内已存在的想法条目文本（按顺序）。空引用行（`>`）分隔条目，
 * 首个条目之前的空白引用行不计。无法识别的块视为无条目。
 */
function parseIdeaEntryTexts(blockText: string): string[] {
	return parseIdeaEntryGroups(blockText).map((entry) => entry.text);
}

/**
 * 追加到块末尾的补丁文本：前导换行承接口上行，随后是空引用行分隔 + 条目组；
 * 不带尾换行（由文档既有换行收尾），避免与原块内容重复。
 */
function appendEntryPatchText(entry: IdeaEntryInput): string {
	const entryLines = [">", ...renderEntryLines(entry)];
	return `\n${entryLines.join("\n")}`;
}

/**
 * 渲染完整块文本：摘录块（头部 + 原文）之下按序堆叠想法条目，
 * 条目之间以及原文与首个条目之间以空引用行分隔。没有条目时原样返回。
 */
export function renderIdeaQuoteBlock(quoteBlock: string, entries: IdeaEntryInput[]): string {
	if (!entries.length) {
		return quoteBlock;
	}
	const base = quoteBlock.replace(/\n+$/, "");
	const segmentLines: string[] = [];
	for (const entry of entries) {
		segmentLines.push(">");
		segmentLines.push(...renderEntryLines(entry));
	}
	return `${base}\n${segmentLines.join("\n")}\n`;
}

/** 追加语义：把整块插入到文档末尾，与既有内容规范为恰好一个空行分隔。 */
function appendBlockToDocEnd(doc: string, block: string): IdeaNoteResult {
	const trailing = (doc.match(/\n*$/) || [""])[0].length;
	const base = doc.slice(0, doc.length - trailing);
	const inserted = (base ? "\n\n" : "") + block;
	const at = offsetToPos(doc, doc.length);
	return {
		outcome: "created",
		doc: base + inserted,
		patch: { from: at, to: at, text: inserted },
	};
}

export interface UpsertIdeaEntryOptions {
	/** 由摘录块构建服务产出、携带真实划线标识的块文本（头部 + 原文）。 */
	quoteBlock: string;
}

/** 定位命中的块内最后一条想法文本；无条目返回空串。 */
function currentLastIdeaText(lines: string[], hit: { start: IdeaEditorPosition; end: IdeaEditorPosition }): string {
	const blockText = lines.slice(hit.start.line, hit.end.line + 1).join("\n");
	const entries = parseIdeaEntryTexts(blockText);
	return entries.length ? entries[entries.length - 1].trim() : "";
}

/** 块内第一个想法条目组的起始行（其前导空引用行的行号）；无条目返回 null。 */
function firstEntryGroupStartLine(blockLines: string[]): number | null {
	for (let i = 0; i < blockLines.length; i += 1) {
		if (IDEA_LABEL_LINE_RE.test(blockLines[i])) {
			return i > 0 && blockLines[i - 1].trim() === ">" ? i - 1 : i;
		}
	}
	return null;
}

/**
 * 想法入笔记 upsert：按身份定位旧块。
 * - 找不到 → created：渲染带该条目的完整块追加到文档末尾；
 * - 找到 → 合并该句全部命中块（保留第一条、迁移其余块的条目并移除它们），
 *   再按「最后一条与本次内容是否相同」决定 appended / noop。
 */
export function upsertIdeaEntry(
	doc: string,
	identity: IdeaBlockIdentity,
	entry: IdeaEntryInput,
	options: UpsertIdeaEntryOptions
): IdeaNoteResult {
	const hits = locateAllIdeaQuoteBlocks(doc, identity);
	if (!hits.length) {
		const block = renderIdeaQuoteBlock(options.quoteBlock, [entry]);
		return { ...appendBlockToDocEnd(doc, block), block };
	}
	const lines = doc.split("\n");
	const keep = hits[0];
	const dups = hits.slice(1);
	const keepLines = lines.slice(keep.start.line, keep.end.line + 1);
	const lastText = currentLastIdeaText(lines, keep);
	// 单一命中块：保持既有「尾部追加 / noop」语义（最小补丁，不触碰历史条目）。
	if (dups.length === 0) {
		if (lastText === entry.text.trim()) {
			return { outcome: "noop", doc };
		}
		const blockText = keepLines.join("\n");
		const at = { line: keep.end.line, ch: lines[keep.end.line].length };
		const insertOffset = offsetOf(doc, at);
		const patchText = appendEntryPatchText(entry);
		const nextDoc = doc.slice(0, insertOffset) + patchText + doc.slice(insertOffset);
		return {
			outcome: "appended",
			doc: nextDoc,
			patch: { from: at, to: at, text: patchText },
			block: blockText + patchText,
		};
	}
	// 同句多块（去重语义）：保留第一条命中块（自带色原文），
	// 迁移其余块的既有条目并按序合并，随后整体移除重复块。
	const keepBaseLineEnd = firstEntryGroupStartLine(keepLines);
	const keepBase = keepLines.slice(0, keepBaseLineEnd ?? keepLines.length).join("\n");
	const mergedEntries: IdeaEntryInput[] = [...parseIdeaEntryGroups(keepLines.join("\n"))];
	for (const dup of dups) {
		const dupText = lines.slice(dup.start.line, dup.end.line + 1).join("\n");
		mergedEntries.push(...parseIdeaEntryGroups(dupText));
	}
	const mergedLast = mergedEntries.length ? mergedEntries[mergedEntries.length - 1].text.trim() : "";
	const finalEntries = mergedLast === entry.text.trim() ? mergedEntries : [...mergedEntries, entry];
	const newBlockText = renderIdeaQuoteBlock(keepBase, finalEntries);
	const from = { line: keep.start.line, ch: 0 };
	const to = { line: keep.end.line, ch: lines[keep.end.line].length };
	// 全部补丁坐标基于原始 doc；消费方须按起点行号**自后向前**应用。
	const allPatches: { from: IdeaEditorPosition; to: IdeaEditorPosition; text: string }[] = [
		{ from, to, text: newBlockText },
		...dups.map((dup) => ({
			from: { line: dup.start.line, ch: 0 },
			to: { line: dup.end.line, ch: lines[dup.end.line].length },
			text: "",
		})),
	];
	allPatches.sort((a, b) => b.from.line - a.from.line);
	let nextDoc = doc;
	for (const p of allPatches) {
		const pFrom = offsetOf(nextDoc, p.from);
		const pTo = offsetOf(nextDoc, p.to);
		nextDoc = nextDoc.slice(0, pFrom) + p.text + nextDoc.slice(pTo);
	}
	return {
		outcome: "appended",
		doc: nextDoc,
		patch: { from, to, text: newBlockText },
		extraPatches: dups.map((dup) => ({
			from: { line: dup.start.line, ch: 0 },
			to: { line: dup.end.line, ch: lines[dup.end.line].length },
			text: "",
		})),
		block: newBlockText,
	};
}

/** 块内最后一个想法条目组的起始行（其前导空引用行的行号）；无条目返回 null。 */
function lastEntryGroupStartLine(blockLines: string[]): number | null {
	let labelIdx = -1;
	for (let i = 0; i < blockLines.length; i += 1) {
		if (IDEA_LABEL_LINE_RE.test(blockLines[i])) {
			labelIdx = i;
		}
	}
	if (labelIdx === -1) {
		return null;
	}
	return labelIdx > 0 && blockLines[labelIdx - 1].trim() === ">" ? labelIdx - 1 : labelIdx;
}

function replaceBlockRange(
	doc: string,
	hit: { start: IdeaEditorPosition; end: IdeaEditorPosition },
	lines: string[],
	newBlockText: string,
	outcome: "replaced" | "stripped"
): IdeaNoteResult {
	const from = { line: hit.start.line, ch: 0 };
	const to = { line: hit.end.line, ch: lines[hit.end.line].length };
	const fromOffset = offsetOf(doc, from);
	const toOffset = offsetOf(doc, to);
	return {
		outcome,
		doc: doc.slice(0, fromOffset) + newBlockText + doc.slice(toOffset),
		patch: { from, to, text: newBlockText },
	};
}

/**
 * 编辑语义：改写最后一条想法条目（含时间戳），历史条目与块头逐字不动。
 * - 无条目块降级为追加（appended，需要 options.quoteBlock）；
 * - 与最后一条内容相同 → noop。
 */
export function rewriteLastIdeaEntry(
	doc: string,
	identity: IdeaBlockIdentity,
	entry: IdeaEntryInput,
	options?: UpsertIdeaEntryOptions
): IdeaNoteResult {
	const hit = locateIdeaQuoteBlock(doc, identity);
	if (!hit || lastEntryGroupStartLine(doc.split("\n").slice(hit.start.line, hit.end.line + 1)) === null) {
		if (!options) {
			return { outcome: "noop", doc };
		}
		return upsertIdeaEntry(doc, identity, entry, options);
	}
	const lines = doc.split("\n");
	const lastText = currentLastIdeaText(lines, hit);
	if (lastText === entry.text.trim()) {
		return { outcome: "noop", doc };
	}
	const blockLines = lines.slice(hit.start.line, hit.end.line + 1);
	const groupStart = lastEntryGroupStartLine(blockLines)!;
	const head = blockLines.slice(0, groupStart);
	const newBlockText = [...head, ">", ...renderEntryLines(entry)].join("\n");
	return { ...replaceBlockRange(doc, hit, lines, newBlockText, "replaced"), block: newBlockText };
}

/**
 * 编辑语义：清空想法时剥离最后一条条目。
 * - 剩余零条目 → 块退化为纯摘录块；无条目 → noop。
 */
export function stripLastIdeaEntry(
	doc: string,
	identity: IdeaBlockIdentity
): IdeaNoteResult {
	const hit = locateIdeaQuoteBlock(doc, identity);
	if (!hit) {
		return { outcome: "noop", doc };
	}
	const lines = doc.split("\n");
	const blockLines = lines.slice(hit.start.line, hit.end.line + 1);
	const groupStart = lastEntryGroupStartLine(blockLines);
	if (groupStart === null) {
		return { outcome: "noop", doc };
	}
	const newBlockText = blockLines.slice(0, groupStart).join("\n");
	return { ...replaceBlockRange(doc, hit, lines, newBlockText, "stripped"), block: newBlockText };
}
