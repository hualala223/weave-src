/**
 * 字色标记（Font mark）装饰纯函数模块。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md（含"严格包含性"修订，
 * 见 docs/specs/fontmark-interaction-and-storage-concurrency.md Further Notes）。
 * - 五个颜色 token：红/金/蓝/绿/紫（"黄"档即 gold，取深金保证浅色背景可读）。
 * - 导出到 MD 用固定 hex（单一事实来源）；书内渲染按明暗主题取色。
 * - decorateExcerptText：把摘录文本按彩色切段包成行内 HTML（span 的 style 仅含 color）。
 * - computeFontMarkOffsets：在同一章节文档内由划线 Range 与标记 Range 求字符偏移；
 *   摘录长度与划线范围不一致时返回 null（selection.toString 差异防护）。
 *
 * 严格包含性（票 07 修订）：导出切段**只承认 Range 证明的包含关系**——标记必须真正
 * 落在划线 Range 内才能染色。不再做字符串回退：同章不同段（或异章）的标记文本即使
 * 恰好出现在摘录中，也绝不染色（因为无法证明该标记钉住了摘录里的那一处文字），
 * 这是"没有标记颜色的文字也有了颜色"类误染的根因。任何失败都跳过该标记，
 * 绝不阻塞导出；输出无色纯文本是可接受的降级（宁可漏染，不可错染）。
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
 * 1. 用宿主注入的 Range 解析（同章节 DOM 内）计算精确偏移；
 * 2. 解析失败或标记不在划线范围内（夹紧后无重叠）→ 跳过该标记，**不做字符串回退**。
 *
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
		// 严格包含性：只认 Range 证明的包含关系。标记 Range 解析失败、或夹紧后与
		// 划线无重叠（越界/异段）时，computeFontMarkOffsets 返回 null——此时一旦
		// 回退字符串查找，就会把摘录里恰好同文的词染上颜色（真实用户数据已复现：
		// 同章不同段的「经济学」标记把另一段摘录里的「经济学」染绿）。故此处
		// 明确跳过，绝不用 mark.text 做兜底匹配。
		const offsets = computeFontMarkOffsets(highlightRange, markRange, text.length);
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

/**
 * 字符串查找工具（保留导出）：在文本中查找标记文本的首个出现位置。
 *
 * 注意：导出管线（buildExcerptDecorationSegments）已按"严格包含性"不再使用本函数——
 * 字符串回退会把同章异段标记误染到摘录同文处。保留仅供诊断/调试与工具用途。
 */
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
 * 计算 Range 在文档中按「文本节点拼接坐标」占据的字符偏移区间。
 * 位置无法解析（节点不在文档树/越界）返回 null。
 */
export function computeRangeTextOffsets(
	doc: Document,
	range: Range
): { start: number; end: number } | null {
	const root = doc.body ?? doc.documentElement;
	if (!root || !range) {
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

	const start = locate({ node: range.startContainer, offset: range.startOffset });
	const end = locate({ node: range.endContainer, offset: range.endOffset });
	if (start === null || end === null || end <= start) {
		return null;
	}
	return { start, end };
}

/**
 * 计算标记 Range 相对划线 Range 的字符偏移区间（按文本节点拼接坐标）。
 * - 两 Range 必须属于同一文档；
 * - excerptTextLength 用于校验「划线范围文本长度 === 摘录长度」，
 *   不一致说明 selection.toString 与 textContent 有差异，返回 null 让调用方降级；
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
	const highlight = computeRangeTextOffsets(doc, highlightRange);
	const mark = computeRangeTextOffsets(doc, markRange);
	if (!highlight || !mark) {
		return null;
	}
	// selection.toString() 可能插入块间分隔符导致与拼接长度不一致——此时偏移不可信。
	if (highlight.end - highlight.start !== excerptTextLength) {
		return null;
	}

	const start = Math.max(mark.start, highlight.start) - highlight.start;
	const rawEnd = Math.min(mark.end, highlight.end) - highlight.start;
	const end = Math.min(rawEnd, excerptTextLength);
	if (end <= start) {
		return null;
	}
	return { start, end };
}
