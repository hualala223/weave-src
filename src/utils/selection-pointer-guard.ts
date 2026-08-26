/**
 * 移动端坐标感知选区守卫（票：移动端点按交互修复）——纯判定共享模块。
 *
 * 背景：Android WebView 的点按不会自动收起文本选区，残留选区 + 盲区守卫（
 * 「存在非折叠选区即旁观」）会把「点空白取消」与「点标记词命中」双双锁死。
 * 本判定用坐标区分两类手势：
 * - 点按落在选区矩形（含端点手柄容差）内 → `standby`：旁观，保护原生拖选手柄扩选；
 * - 点按在选区外 / 无选区 / 非移动端 / 坐标不可比 → `cancel`：可走 dismiss + 清选区。
 *
 * 坐标系约定：point 与 selectionRects 必须是同一视图空间（iframe 内事件坐标与
 * 该 iframe 文档的选区矩形一致）；跨文档场景由调用方先行降级为无矩形集。
 *
 * 不依赖 obsidian / DOM：工具条守卫（components）与引擎点击守门员（services）
 * 共用本模块，避免 components → services 反向依赖。
 */

/** 选区矩形（仅命中判定所需的四边；DOMRect / ToolbarRect 结构可赋值）。 */
export interface SelectionRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type SelectionPointerVerdict = "standby" | "cancel";

export interface SelectionPointerGuardInput {
	/** 是否移动端（守卫仅移动端启用）。 */
	mobile: boolean;
	/** 本次点按所依附文档是否存在非折叠文本选区。 */
	hasNonCollapsedSelection: boolean;
	/** 点按坐标（与 selectionRects 同坐标系）；不可用时为 null。 */
	point: { x: number; y: number } | null;
	/** 选区矩形集（与 point 同坐标系）；空数组视为无物可保护。 */
	selectionRects: readonly SelectionRect[];
	/** 端点手柄容差（px）：手柄拖拽起点可略越出选区边界；负值按 0 处理。 */
	handleTolerance: number;
}

/** 端点手柄容差（px）的单一事实来源：工具条守卫与引擎点击守门员共用。 */
export const SELECTION_HANDLE_TOLERANCE_PX = 12;

/**
 * DOM 侧矩形收集（形状归一化 + 过滤零面积）：把 Selection 的 Range 客户端矩形
 * 规整为判定可用的 SelectionRect[]。非折叠选区检查与 try/catch 内置于本函数，
 * 工具条守卫与引擎点击守门员共用，避免两处逐字重复的收集循环。
 */
export function collectSelectionRects(
	selection: Selection | null | undefined,
	filterZeroArea = true
): SelectionRect[] {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return [];
	}
	let range: Range;
	try {
		range = selection.getRangeAt(0);
	} catch {
		return [];
	}
	const rects: SelectionRect[] = [];
	for (const r of range.getClientRects()) {
		if (filterZeroArea && (r.width <= 0 || r.height <= 0)) {
			continue;
		}
		rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	}
	return rects;
}

export function decideSelectionPointerGuard(
	input: SelectionPointerGuardInput
): SelectionPointerVerdict {
	const { mobile, hasNonCollapsedSelection, point, selectionRects, handleTolerance } = input;
	if (!mobile || !hasNonCollapsedSelection) {
		return "cancel";
	}
	// 坐标不可用（合成事件/跨文档降级）时保守旁观：维持「不清选区、不误关」的旧行为。
	if (!point) {
		return "standby";
	}
	const tolerance = Math.max(0, handleTolerance);
	for (const rect of selectionRects) {
		if (
			point.x >= rect.left - tolerance &&
			point.x <= rect.right + tolerance &&
			point.y >= rect.top - tolerance &&
			point.y <= rect.bottom + tolerance
		) {
			return "standby";
		}
	}
	return "cancel";
}