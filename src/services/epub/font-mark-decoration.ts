/**
 * 字色标记（Font mark）装饰纯函数模块。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md。
 * - 五个颜色 token：红/金/蓝/绿/紫（"黄"档即 gold，取深金保证浅色背景可读）。
 * - 导出到 MD 用固定 hex（单一事实来源）；书内渲染按明暗主题取色。
 * - decorateExcerptText：把摘录文本按彩色切段包成行内 HTML（span 的 style 仅含 color）。
 * - computeFontMarkOffsets：在同一章节文档内由划线 Range 与标记 Range 求字符偏移；
 *   摘录长度与划线范围不一致时返回 null（selection.toString 差异防护），
 *   调用方应回退到 findFontMarkByText 字符串匹配，再失败则退化为无色纯文本。
 *
 * 任何失败都不抛异常：字色只是增强，导出永不因它阻塞。
 */

export type FontMarkColorToken = "red" | "gold" | "blue" | "green" | "purple";

export const FONT_MARK_COLOR_TOKENS = ["red", "gold", "blue", "green", "purple"] as const;

export const FONT_MARK_EXPORT_HEX: Record<FontMarkColorToken, string> = {
	red: "#dc2626",
	gold: "#b45309",
	blue: "#2563eb",
	green: "#16a34a",
	purple: "#9333ea",
};

/** 书内渲染色：浅色主题与导出一致；深色主题用亮色变体保证可读。 */
const FONT_MARK_BOOK_TINTS: Record<"light" | "dark", Record<FontMarkColorToken, string>> = {
	light: { ...FONT_MARK_EXPORT_HEX },
	dark: {
		red: "rgb(248, 113, 113)",
		gold: "#fbbf24",
		blue: "rgb(96, 165, 250)",
		green: "rgb(74, 222, 128)",
		purple: "rgb(196, 181, 253)",
	},
};

export function isFontMarkColorToken(value: unknown): value is FontMarkColorToken {
	return (
		typeof value === "string" &&
		(FONT_MARK_COLOR_TOKENS as readonly string[]).includes(value)
	);
}

export function resolveFontMarkBookTint(
	color: FontMarkColorToken,
	scheme: "light" | "dark",
): string {
	return FONT_MARK_BOOK_TINTS[scheme][color];
}

export interface FontMarkSegment {
	start: number;
	end: number;
	color: FontMarkColorToken;
}

/**
 * 导出装饰编排：把「摘录文本 + 候选字色标记」统一为偏移切段。
 *
 * 对每个标记：
 * 1. 优先用宿主注入的 Range 解析（同章节 DOM 内）计算精确偏移；
 * 2. 解析失败回退字符串查找标记文本；
 * 3. 仍失败则该标记被跳过。
 * 任何情况都不抛异常——字色只是增强。
 */
export function buildExcerptDecorationSegments(input: {
	text: string;
	highlightCfiRange: string;
	marks: Array<{ cfiRange: string; text?: string; color: unknown }>;
	resolveRange: (cfiRange: string) => Range | null;
}): FontMarkSegment[] {
	const { text, marks, resolveRange } = input;
	if (!text || !marks?.length) {
		return [];
	}
	// 划线范围是整个引用的基线，一次解析供所有标记复用（同节约束已由调用方保证）。
	const highlightRange = resolveRange(input.highlightCfiRange);
	const segments: FontMarkSegment[] = [];
	for (const mark of marks) {
		if (!isFontMarkColorToken(mark.color)) {
			continue;
		}
		const markRange = resolveRange(mark.cfiRange);
		let offsets = computeFontMarkOffsets(highlightRange, markRange, text.length);
		if (!offsets && mark.text) {
			offsets = findFontMarkByText(text, mark.text);
		}
		if (offsets) {
			segments.push({ ...offsets, color: mark.color });
		}
	}
	return segments;
}

function wrapWithColorSpan(text: string, color: FontMarkColorToken): string {
	return `<span style="color:${FONT_MARK_EXPORT_HEX[color]}">${text}</span>`;
}

/**
 * 把彩色切段包进行内 HTML。切段越界裁剪、空段丢弃；
 * 相互重叠时起点优先裁剪，不产生嵌套 span。
 */
export function decorateExcerptText(text: string, segments: FontMarkSegment[]): string {
	if (!text || segments.length === 0) {
		return text;
	}
	const cleaned = segments
		.filter((segment) => isFontMarkColorToken(segment.color))
		.map((segment) => ({
			start: Math.max(0, Math.floor(segment.start)),
			end: Math.min(text.length, Math.ceil(segment.end)),
			color: segment.color,
		}))
		.filter((segment) => segment.end > segment.start)
		.sort((left, right) => left.start - right.start);

	let out = "";
	let pos = 0;
	let lastEnd = 0;
	for (const segment of cleaned) {
		const start = Math.max(segment.start, lastEnd);
		if (start >= segment.end) {
			continue;
		}
		out += text.slice(pos, start);
		out += wrapWithColorSpan(text.slice(start, segment.end), segment.color);
		pos = segment.end;
		lastEnd = segment.end;
	}
	out += text.slice(pos);
	return out;
}

/** 回退方案：在摘录文本中查找标记文本的首个出现位置。 */
export function findFontMarkByText(
	text: string,
	markText: string,
): { start: number; end: number } | null {
	const needle = String(markText || "").trim();
	if (!needle || !text) {
		return null;
	}
	const index = text.indexOf(needle);
	if (index < 0) {
		return null;
	}
	return { start: index, end: index + needle.length };
}

interface BoundaryPosition {
	node: Node;
	offset: number;
}

function isTextNode(node: Node): node is Text {
	return node.nodeType === Node.TEXT_NODE;
}

function subtreeTextLength(node: Node): number {
	if (isTextNode(node)) {
		return node.data.length;
	}
	let total = 0;
	const walker = node.ownerDocument?.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	if (!walker) {
		return total;
	}
	while (walker.nextNode()) {
		total += (walker.currentNode as Text).data.length;
	}
	return total;
}

/**
 * 计算标记 Range 相对划线 Range 的字符偏移区间（按文本节点拼接坐标）。
 * - 两 Range 必须属于同一文档；
 * - excerptTextLength 用于校验「划线范围文本长度 === 摘录长度」，
 *   不一致说明 selection.toString 与 textContent 有差异，返回 null 让调用方回退；
 * - 无重叠返回 null；重叠部分按两侧夹紧（越界忽略语义）。
 */
export function computeFontMarkOffsets(
	highlightRange: Range | null | undefined,
	markRange: Range | null | undefined,
	excerptTextLength: number,
): { start: number; end: number } | null {
	if (!highlightRange || !markRange) {
		return null;
	}
	const doc = highlightRange.startContainer.ownerDocument;
	if (!doc || markRange.startContainer.ownerDocument !== doc) {
		return null;
	}
	const root = doc.body ?? doc.documentElement;
	if (!root) {
		return null;
	}

	// 单次游走建立「文本节点 → 前缀累计偏移」表。
	const nodeStart = new Map<Node, number>();
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let acc = 0;
	while (walker.nextNode()) {
		nodeStart.set(walker.currentNode, acc);
		acc += (walker.currentNode as Text).data.length;
	}

	const locate = (boundary: BoundaryPosition): number | null => {
		const { node, offset } = boundary;
		if (!node) {
			return null;
		}
		if (isTextNode(node)) {
			const start = nodeStart.get(node);
			return start === undefined ? null : start + offset;
		}
		// 元素容器：offset 表示之前的孩子个数，累加各孩子子树的文本长度。
		let position = 0;
		for (let index = 0; index < offset; index++) {
			const child = node.childNodes[index];
			if (!child) {
				break;
			}
			position += subtreeTextLength(child);
		}
		return position;
	};

	const highlightStart = locate({ node: highlightRange.startContainer, offset: highlightRange.startOffset });
	const highlightEnd = locate({ node: highlightRange.endContainer, offset: highlightRange.endOffset });
	const markStart = locate({ node: markRange.startContainer, offset: markRange.startOffset });
	const markEnd = locate({ node: markRange.endContainer, offset: markRange.endOffset });
	if (
		highlightStart === null ||
		highlightEnd === null ||
		markStart === null ||
		markEnd === null
	) {
		return null;
	}
	if (highlightEnd <= highlightStart) {
		return null;
	}
	// selection.toString() 可能插入块间分隔符导致与拼接长度不一致——此时偏移不可信。
	if (highlightEnd - highlightStart !== excerptTextLength) {
		return null;
	}

	const start = Math.max(markStart, highlightStart) - highlightStart;
	const rawEnd = Math.min(markEnd, highlightEnd) - highlightStart;
	const end = Math.min(rawEnd, excerptTextLength);
	if (end <= start) {
		return null;
	}
	return { start, end };
}
