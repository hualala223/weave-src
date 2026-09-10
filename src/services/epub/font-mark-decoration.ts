/**
 * 字色标记（Font mark）装饰纯函数模块。
 *
 * 规格：docs/specs/font-marks-and-auto-insert-end.md（含"严格包含性"修订，
 * 见 docs/specs/fontmark-interaction-and-storage-concurrency.md Further Notes）；
 * 找回（三路共用）见 docs/specs/font-mark-resolution-recovery.md（票 08）。
 * - 五个颜色 token：红/金/蓝/绿/紫（"黄"档即 gold，取深金保证浅色背景可读）。
 * - 导出到 MD 用固定 hex（单一事实来源）；书内渲染按明暗主题取色。
 * - decorateExcerptText：把摘录文本按彩色切段包成行内 HTML（span 的 style 仅含 color）。
 * - 坐标系为**块感知文本坐标**：文本节点按文档序拼接、跨块边界计 1 个 "\n"
 *   （与 selection.toString 同构）、首尾空白不计（对齐 .trim()）；computeFontMarkOffsets/
 *   computeFontMarkOffsetsWithIndex 在该坐标系内由划线 Range 与标记 Range 求字符偏移，
 *   摘录长度与划线范围内容不一致时返回 null（选择差异防护）。
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
 * 对每个标记（同节候选已由调用方保证）：
 * 1. 划线基线可解析时，用块感知偏移精确切段（Range 证明优先，严格包含性）；
 * 2. 偏移切段失败（标记 Range 不可用/无重叠）**或基线本身解析失败**时，
 *    回退「摘录内文本回退」（带唯一性闸）：标记文本在摘录内**唯一出现**才染——
 *    用户标记过的词唯一出现在所划句子中，染上它是预期行为（8/25 成功版语义，
 *    票 08 修订恢复；ac3a3d8 的"基线失败即整体放弃"被证伪：用户主场景是
 *    反复出现的主题词，CFI 常解析失败，整体放弃等于让句子里的词永远无色）；
 *    多次出现则无法证明用户标记的是哪一处，跳过不染（防误染唯一性闸）；
 * 3. 两级都失败则跳过该标记（无色纯文本降级，绝不阻塞导出）。
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
	const segments: FontMarkSegment[] = [];
	// 划线基线（偏移计算的锚）：可解析则走块感知偏移；基线 CFI 解析失败不再
	// 整体放弃——标记直接由摘录内文本回退定位（基线对回退不是前置条件）。
	const highlightRange = resolveRange(input.highlightCfiRange);
	const index = highlightRange
		? buildBlockAwareIndex(highlightRange.startContainer.ownerDocument)
		: null;
	for (const mark of marks) {
		if (!isFontMarkColorToken(mark.color)) {
			continue;
		}
		let offsets: { start: number; end: number } | null = null;
		if (highlightRange && index) {
			const markRange = resolveRange(mark.cfiRange);
			// 严格包含性（偏移优先）：只认 Range 证明的偏移；无重叠/越界/解析失败
			// 返回 null，才走下一级回退。
			offsets = computeFontMarkOffsetsWithIndex(index, highlightRange, markRange, text.length);
		}
		// 摘录内文本回退（最后一级，同时覆盖基线失败场景）：标记文本须在摘录内
		// **唯一出现**才按文本定位——多次出现无法证明用户标记的是哪一处，首现
		// 回退会把颜色落在错误的那处（宁可漏染，不可错染）。同节约束已由调用方保证。
		if (!offsets && mark.text) {
			offsets = findUniqueFontMarkByText(text, mark.text);
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

/**
 * 字符串查找工具（保留导出）：在文本中查找标记文本的首个出现位置。
 *
 * 注意：导出管线（buildExcerptDecorationSegments）使用的是下方带唯一性闸的
 * findUniqueFontMarkByText——首现回退会把多次出现的词染到错误的那处。
 * 本函数保留仅供诊断/调试与工具用途。
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

/**
 * 导出文本回退（带唯一性闸）：仅当标记文本在摘录文本内**唯一出现**时返回其
 * 首现（=唯一）位置；出现多次或不存在一律返回 null，标记降级为纯文本。
 * 与书内渲染找回管线的「唯一出现才降级」闸同构：宁可漏染，不可错染。
 */
export function findUniqueFontMarkByText(
	text: string,
	markText: string,
): { start: number; end: number } | null {
	const first = findFontMarkByText(text, markText);
	if (!first) {
		return null;
	}
	const needle = String(markText || "").trim();
	return text.indexOf(needle, first.end) >= 0 ? null : first;
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
 * 块级元素白名单：按 contents 语义（selection.toString 在块间插入 "\n"）。
 * 覆盖真实 EPUB 章节里常见的结构化块；不在表内的一律视为行内（不插分隔符）。
 */
const BLOCK_LEVEL_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figure",
	"figcaption",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"td",
	"th",
	"tr",
	"ul",
]);

/** 向上找最近的块级元素祖先（含节点自身；不含 body/html——根容器不参与分隔判定）。 */
function nearestBlockElement(node: Node): Element | null {
	let current: Node | null = node;
	while (current) {
		if (current.nodeType === Node.ELEMENT_NODE) {
			const element = current as Element;
			if (BLOCK_LEVEL_TAGS.has(element.tagName.toLowerCase())) {
				return element;
			}
		}
		current = current.parentNode;
	}
	return null;
}

export interface BlockAwareIndex {
	/** 全局块感知文本：文本节点按文档序拼接，跨块边界插入一个 "\n"。 */
	text: string;
	/** 文本节点 → 其文本在全局块感知文本中的起点。 */
	nodeStart: Map<Node, number>;
}

/**
 * 构建全局「块感知文本」索引。
 *
 * selection.toString() 会在块级元素边界插入 "\n"，而文本节点纯拼接没有分隔符——
 * 真实选区的 `selection.toString().trim()` 与纯拼接坐标必然不一致，导致
 * computeFontMarkOffsets 的长度守卫在跨段划线时必挂。本索引在拼接游走时，
 * 凡两个文本节点的「最近块级祖先」不同（跨块），其间计入 1 个 "\n"，
 * 得到与 `selection.toString()` 同构的文本与坐标。
 */
function buildBlockAwareIndex(doc: Document): BlockAwareIndex | null {
	const root = doc.body ?? doc.documentElement;
	if (!root) {
		return null;
	}
	const parts: string[] = [];
	const nodeStart = new Map<Node, number>();
	let acc = 0;
	let previousBlock: Element | null = null;
	let hasContent = false;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const textNode = walker.currentNode as Text;
		const block = nearestBlockElement(textNode);
		if (hasContent && block !== previousBlock) {
			// 跨块边界：selection.toString 在此插入 "\n"。
			parts.push("\n");
			acc += 1;
		}
		nodeStart.set(textNode, acc);
		parts.push(textNode.data);
		acc += textNode.data.length;
		previousBlock = block;
		hasContent = true;
	}
	return { text: parts.join(""), nodeStart };
}

/** 用块感知索引定位边界（文本节点精确；元素容器按子树近似对齐）。 */
function locateBlockAwareBoundary(
	index: BlockAwareIndex,
	boundary: BoundaryPosition
): number | null {
	const { node, offset } = boundary;
	if (!node) {
		return null;
	}
	if (isTextNode(node)) {
		const start = index.nodeStart.get(node);
		return start === undefined ? null : start + offset;
	}
	// 元素容器：容器内首个文本节点的全局起点 + 前 offset 个孩子子树（块感知）长度。
	const firstText = firstTextDescendant(node);
	const anchor = firstText ? index.nodeStart.get(firstText) : undefined;
	if (anchor === undefined) {
		return null;
	}
	let relative = 0;
	let previousBlock: Element | null = null;
	let hasContent = false;
	for (let childIndex = 0; childIndex < offset; childIndex++) {
		const child = node.childNodes[childIndex];
		if (!child) {
			break;
		}
		const childLength = subtreeBlockAwareTextLength(child);
		if (hasContent && childLength > 0) {
			const childBlock = nearestBlockElement(child);
			if (childBlock !== previousBlock) {
				relative += 1;
			}
		}
		relative += childLength;
		if (childLength > 0) {
			hasContent = true;
			previousBlock = subtreeLastBlockElement(child) ?? previousBlock;
		}
	}
	return anchor + relative;
}

function firstTextDescendant(node: Node): Text | null {
	if (isTextNode(node)) {
		return node;
	}
	const walker = node.ownerDocument?.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	if (!walker) {
		return null;
	}
	return walker.nextNode() ? (walker.currentNode as Text) : null;
}

/** 子树按「块感知」计数的文本长度（跨块边界 +1，与全局游走同规）。 */
function subtreeBlockAwareTextLength(node: Node): number {
	if (isTextNode(node)) {
		return node.data.length;
	}
	let total = 0;
	let previousBlock: Element | null = null;
	let hasContent = false;
	const walker = node.ownerDocument?.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	if (!walker) {
		return total;
	}
	while (walker.nextNode()) {
		const textNode = walker.currentNode as Text;
		const block = nearestBlockElement(textNode);
		if (hasContent && block !== previousBlock) {
			total += 1;
		}
		total += textNode.data.length;
		previousBlock = block;
		hasContent = true;
	}
	return total;
}

function subtreeLastBlockElement(node: Node): Element | null {
	if (node.nodeType === Node.ELEMENT_NODE) {
		const element = node as Element;
		if (BLOCK_LEVEL_TAGS.has(element.tagName.toLowerCase())) {
			return element;
		}
	}
	const walker = node.ownerDocument?.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
	if (!walker) {
		return null;
	}
	let last: Element | null = null;
	while (walker.nextNode()) {
		const element = walker.currentNode as Element;
		if (BLOCK_LEVEL_TAGS.has(element.tagName.toLowerCase())) {
			last = element;
		}
	}
	return last;
}

function leadingWhitespaceCount(text: string): number {
	let count = 0;
	for (const char of text) {
		if (/\s/.test(char)) {
			count += 1;
		} else {
			break;
		}
	}
	return count;
}

function trailingWhitespaceCount(text: string): number {
	let count = 0;
	for (let index = text.length - 1; index >= 0; index -= 1) {
		if (/\s/.test(text[index])) {
			count += 1;
		} else {
			break;
		}
	}
	return count;
}

/**
 * 计算标记 Range 相对划线 Range 的字符偏移区间。
 *
 * 坐标系：**块感知文本坐标**（文本节点拼接 + 跨块 "\n" + 首尾 trim），
 * 与 `selection.toString().trim()` 同构——真实选区的跨段划线（"\n" 分隔）
 * 与选区边缘空白（被 trim）不再触发长度守卫误判。
 * - 两 Range 必须属于同一文档；
 * - excerptTextLength 用于校验「划线范围文本长度 === 摘录长度」，
 *   不一致（内容差异超过块分隔/空白容差）时返回 null 让调用方降级；
 * - 标记偏移在 trim 后的坐标系中换算，与摘录文本逐字符对齐；
 * - 无重叠返回 null；重叠部分按两侧夹紧（越界忽略语义）。
 *
 * 仍遵守「严格包含性」：只认 Range 证明的包含关系，绝不字符串回退。
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
	const index = buildBlockAwareIndex(doc);
	if (!index) {
		return null;
	}
	return computeFontMarkOffsetsWithIndex(index, highlightRange, markRange, excerptTextLength);
}

/**
 * 复用已构建的块感知索引计算标记偏移（编排函数一次建索引、多标记复用）。
 * 语义与 computeFontMarkOffsets 完全一致；索引必须来自同一文档。
 */
export function computeFontMarkOffsetsWithIndex(
	index: BlockAwareIndex,
	highlightRange: Range | null | undefined,
	markRange: Range | null | undefined,
	excerptTextLength: number,
): { start: number; end: number } | null {
	if (!highlightRange || !markRange) {
		return null;
	}
	const highlight = locateBlockAwareBoundary(index, {
		node: highlightRange.startContainer,
		offset: highlightRange.startOffset,
	});
	const highlightEnd = locateBlockAwareBoundary(index, {
		node: highlightRange.endContainer,
		offset: highlightRange.endOffset,
	});
	const mark = locateBlockAwareBoundary(index, {
		node: markRange.startContainer,
		offset: markRange.startOffset,
	});
	const markEnd = locateBlockAwareBoundary(index, {
		node: markRange.endContainer,
		offset: markRange.endOffset,
	});
	if (
		highlight === null ||
		highlightEnd === null ||
		mark === null ||
		markEnd === null ||
		highlightEnd <= highlight ||
		markEnd <= mark
	) {
		return null;
	}

	// 划线范围内的块感知文本（含 "\n"），trim 后应正好等于摘录（selection.toString().trim()）。
	const rawText = index.text.slice(highlight, highlightEnd);
	const leading = leadingWhitespaceCount(rawText);
	const trailing = trailingWhitespaceCount(rawText);
	const trimmedLength = rawText.length - leading - trailing;
	if (trimmedLength !== excerptTextLength) {
		return null;
	}

	const shift = leading;
	const start = Math.max(mark, highlight + shift) - (highlight + shift);
	const rawEnd = Math.min(markEnd, highlightEnd - trailing) - (highlight + shift);
	const end = Math.min(rawEnd, excerptTextLength);
	if (end <= start) {
		return null;
	}
	return { start, end };
}
