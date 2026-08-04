/**
 * 阅读器点按翻页区域（tap zones）。
 *
 * 移动端分页模式下：点按内容区下方 60% 区域 → 下一页，上方 40% 区域 → 上一页。
 * 长按（触发原生文字选择）不翻页；拖动（foliate 滑动翻页）不翻页；
 * 当前存在（或刚刚存在）文字选区时不翻页；命中链接/交互元素时不翻页（链接交给 foliate 处理）。
 *
 * EPUB 内容渲染在 iframe 中，事件不会冒泡到宿主，因此监听器必须挂到每个 frame document 上
 * （与 foliate-paginator 自身的 touch 监听、本服务的 attachSelectionListeners 同一模式）。
 */

export type ReaderTapZone = 'prev' | 'next';

export interface ReaderTapEvent {
	zone: ReaderTapZone;
	clientX: number;
	clientY: number;
	frameHeight: number;
	timeStamp: number;
}

/** 上方多少比例属于「上一页」区域。 */
export const TAP_ZONE_PREV_RATIO = 0.4;
/** 三连击判定窗口：与上一次点按的间隔超过该值视为新连击。 */
export const TAP_TRIPLE_WINDOW_MS = 300;
/** 首次点按后等待该时长再翻页，给三连击留判定余地（100ms 兼顾跟手与三连击）。 */
export const TAP_FLIP_GRACE_MS = 100;
/** 按住多久视为长按（取消点按翻页）。 */
export const TAP_LONG_PRESS_MS = 500;
/** 手指移动超过该距离视为拖动（取消点按翻页）。 */
export const TAP_MOVE_TOLERANCE_PX = 12;
/** 该时间窗内出现过文字选区时，点按不翻页（避免「长按选词后点空白处收起工具条」误翻页）。 */
export const TAP_RECENT_SELECTION_MS = 600;
/** 命中这些元素时不触发翻页（链接/表单等交给原生行为与 foliate）。 */
export const TAP_INTERACTIVE_SELECTOR =
	'a, button, input, textarea, select, summary, label, [contenteditable="true"], [role="button"], [role="link"]';

/**
 * 依据触点纵向位置解析翻页方向。
 * @param clientY 触点相对 frame 视口顶部的 Y（frame 坐标系）
 * @param frameHeight frame 视口高度
 */
export function resolveTapZone(clientY: number, frameHeight: number): ReaderTapZone {
	if (!Number.isFinite(clientY) || !(frameHeight > 0)) {
		return 'next';
	}
	return clientY / frameHeight < TAP_ZONE_PREV_RATIO ? 'prev' : 'next';
}

export interface TapBurstOptions {
	/** 两次点按之间的最大间隔（毫秒），超过则视为新一轮。 */
	windowMs?: number;
}

export interface TapBurstTracker {
	/** 记录一次点按，返回当前连击次数（1 起，达到 3 表示三连击）。 */
	push(tap: { time: number }): number;
	reset(): void;
}

/**
 * 连击计数器：时间窗内连续点按计数，用于「三连击切换全屏」（与 full-screen-cross-platform 一致）。
 * 纯逻辑，便于单测。
 */
export function createTapBurstTracker(options: TapBurstOptions = {}): TapBurstTracker {
	const { windowMs = TAP_TRIPLE_WINDOW_MS } = options;
	let lastTime = -Infinity;
	let count = 0;

	return {
		push(tap) {
			if (!Number.isFinite(tap.time) || tap.time - lastTime > windowMs) {
				count = 1;
			} else {
				count += 1;
			}
			lastTime = tap.time;
			return count;
		},
		reset() {
			lastTime = -Infinity;
			count = 0;
		},
	};
}

export interface ReaderTapZoneController {
	setEnabled(enabled: boolean): void;
	isEnabled(): boolean;
	/** 为单个 frame document 挂载监听，返回卸载函数。 */
	attach(doc: Document): () => void;
	onTap(callback: (event: ReaderTapEvent) => void): () => void;
	dispose(): void;
}

/** 点按是否应被拦截（命中高亮等阅读内容覆盖物时返回 true）。 */
export type TapZoneBlockPredicate = (
	point: { x: number; y: number },
	doc: Document
) => boolean;

export interface ReaderTapZoneControllerOptions {
	/** 点按位置命中高亮/划线覆盖物时拦截翻页（由服务注入高亮命中检测）。 */
	shouldBlockTap?: TapZoneBlockPredicate;
}

interface DocTapState {
	startX: number;
	startY: number;
	moved: boolean;
	longPressed: boolean;
	longPressTimer: number | null;
	lastSelectionActiveAt: number;
	/** 本次手势开始时已有文字选区（点按=收起选区，不得翻页）。 */
	suppressGesture: boolean;
}

function getFrameViewportHeight(doc: Document): number {
	const fallback = doc.documentElement?.clientHeight || doc.defaultView?.innerHeight || 0;
	// 缩放/键盘场景下 visualViewport 高度与触点坐标系一致，优先使用。
	const visualHeight = doc.defaultView?.visualViewport?.height;
	return Number.isFinite(visualHeight) && (visualHeight as number) > 0
		? (visualHeight as number)
		: fallback;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
	const node = target as { nodeType?: number; closest?: (selector: string) => unknown } | null;
	if (!node || typeof node.nodeType !== 'number' || typeof node.closest !== 'function') {
		return false;
	}
	return Boolean(node.closest(TAP_INTERACTIVE_SELECTOR));
}

function hasActiveSelection(doc: Document): boolean {
	const selection = doc.getSelection?.();
	return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
}

export function createReaderTapZoneController(
	options: ReaderTapZoneControllerOptions = {}
): ReaderTapZoneController {
	const { shouldBlockTap } = options;
	let enabled = false;
	const tapCallbacks = new Set<(event: ReaderTapEvent) => void>();
	function emit(event: ReaderTapEvent): void {
		for (const callback of tapCallbacks) {
			try {
				callback(event);
			} catch (error) {
				// 单个回调异常不影响其他回调与监听器生命周期。
				console.warn('[reader-tap-zones] tap callback failed:', error);
			}
		}
	}

	function attach(doc: Document): () => void {
		const state: DocTapState = {
			startX: 0,
			startY: 0,
			moved: false,
			longPressed: false,
			longPressTimer: null,
			lastSelectionActiveAt: 0,
			suppressGesture: false,
		};

		const clearLongPressTimer = () => {
			if (state.longPressTimer) {
				window.clearTimeout(state.longPressTimer);
				state.longPressTimer = null;
			}
		};

		const onSelectionChange = () => {
			if (hasActiveSelection(doc)) {
				state.lastSelectionActiveAt = performance.now();
			}
		};

		const onTouchStart = (event: TouchEvent) => {
			const touch = event.changedTouches?.[0];
			if (!touch) {
				return;
			}
			state.startX = touch.clientX;
			state.startY = touch.clientY;
			state.moved = false;
			state.longPressed = false;
			state.suppressGesture = hasActiveSelection(doc);
			clearLongPressTimer();
			state.longPressTimer = window.setTimeout(() => {
				state.longPressed = true;
			}, TAP_LONG_PRESS_MS);
		};

		const onTouchMove = (event: TouchEvent) => {
			const touch = event.changedTouches?.[0];
			if (!touch) {
				return;
			}
			const dx = touch.clientX - state.startX;
			const dy = touch.clientY - state.startY;
			if (Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE_PX) {
				state.moved = true;
				clearLongPressTimer();
			}
		};

		const onTouchEnd = (event: TouchEvent) => {
			clearLongPressTimer();
			if (!enabled) {
				return;
			}
			if (state.moved || state.longPressed || state.suppressGesture) {
				return;
			}
			const touch = event.changedTouches?.[0];
			if (!touch) {
				return;
			}
			if (hasActiveSelection(doc)) {
				return;
			}
			if (performance.now() - state.lastSelectionActiveAt < TAP_RECENT_SELECTION_MS) {
				return;
			}
			if (isInteractiveTarget(event.target)) {
				return;
			}
			if (shouldBlockTap?.({ x: touch.clientX, y: touch.clientY }, doc)) {
				return;
			}
			const frameHeight = getFrameViewportHeight(doc);
			emit({
				zone: resolveTapZone(touch.clientY, frameHeight),
				clientX: touch.clientX,
				clientY: touch.clientY,
				frameHeight,
				timeStamp: event.timeStamp,
			});
		};

		doc.addEventListener('touchstart', onTouchStart, { passive: true });
		doc.addEventListener('touchmove', onTouchMove, { passive: true });
		doc.addEventListener('touchend', onTouchEnd, { passive: true });
		doc.addEventListener('selectionchange', onSelectionChange);

		return () => {
			clearLongPressTimer();
			doc.removeEventListener('touchstart', onTouchStart);
			doc.removeEventListener('touchmove', onTouchMove);
			doc.removeEventListener('touchend', onTouchEnd);
			doc.removeEventListener('selectionchange', onSelectionChange);
		};
	}

	return {
		setEnabled(next: boolean) {
			enabled = next;
		},
		isEnabled() {
			return enabled;
		},
		attach,
		onTap(callback) {
			tapCallbacks.add(callback);
			return () => {
				tapCallbacks.delete(callback);
			};
		},
		dispose() {
			tapCallbacks.clear();
		},
	};
}
