/**
 * 阅读器点按翻页区域（tap zones）。
 *
 * 移动端分页模式下：点按内容区下方 60% 区域 → 下一页，上方 40% 区域 → 上一页。
 * 长按（触发原生文字选择）不翻页；拖动（foliate 滑动翻页）不翻页；
 * 当前存在（或刚刚存在）文字选区时不翻页；命中链接/交互元素时不翻页（链接交给 foliate 处理）。
 * 单击立即翻页（无防抖/双击延迟）。
 *
 * 多指手势：双指轻点（基本同时按下并抬起、无位移）→ 触发「双指点击」事件（切换全屏用），
 * 不参与翻页判定；任何包含多指的手势都不会被当作单击翻页。
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

/** 双指轻点事件（正文内容区内，用于切换全屏）。 */
export interface ReaderTwoFingerTapEvent {
	clientX: number;
	clientY: number;
	timeStamp: number;
}

/** 上方多少比例属于「上一页」区域。 */
export const TAP_ZONE_PREV_RATIO = 0.4;
/** 按住多久视为长按（取消点按翻页）。 */
export const TAP_LONG_PRESS_MS = 500;
/** 手指移动超过该距离视为拖动（取消点按翻页 / 双指轻点判定）。 */
export const TAP_MOVE_TOLERANCE_PX = 12;
/** 该时间窗内出现过文字选区时，点按不翻页（避免「长按选词后点空白处收起工具条」误翻页）。 */
export const TAP_RECENT_SELECTION_MS = 600;
/** 命中这些元素时不触发翻页（链接/表单等交给原生行为与 foliate）；img 交给图片提取流程。 */
export const TAP_INTERACTIVE_SELECTOR =
	'a, button, input, textarea, select, summary, label, [contenteditable="true"], [role="button"], [role="link"], img';

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

export interface ReaderTapZoneController {
	setEnabled(enabled: boolean): void;
	isEnabled(): boolean;
	/** 为单个 frame document 挂载监听，返回卸载函数。 */
	attach(doc: Document): () => void;
	onTap(callback: (event: ReaderTapEvent) => void): () => void;
	onTwoFingerTap(callback: (event: ReaderTwoFingerTapEvent) => void): () => void;
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
	/** 每个仍按下的触点（identifier → 起点坐标）。 */
	startPoints: Map<number, { x: number; y: number }>;
	/** 当前按下的触点总数。 */
	pointerCount: number;
	/** 本手势期间的峰值触点总数（用于区分单指/双指）。 */
	peakPointers: number;
	moved: boolean;
	longPressed: boolean;
	longPressTimer: number | null;
	lastSelectionActiveAt: number;
	/** 最近一次选区被收起/清空的时刻（收起后短暂窗口内点按也不翻页，避免误翻页）。 */
	selectionClosedAt: number;
	/** 本次手势开始时已有文字选区（点按=收起选区，不得翻页）。 */
	suppressGesture: boolean;
}

function createDocTapState(): DocTapState {
	return {
		startPoints: new Map(),
		pointerCount: 0,
		peakPointers: 0,
		moved: false,
		longPressed: false,
		longPressTimer: null,
		lastSelectionActiveAt: 0,
		selectionClosedAt: 0,
		selectionOpen: false,
		suppressGesture: false,
	};
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
	const twoFingerTapCallbacks = new Set<(event: ReaderTwoFingerTapEvent) => void>();

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

	function emitTwoFingerTap(event: ReaderTwoFingerTapEvent): void {
		for (const callback of twoFingerTapCallbacks) {
			try {
				callback(event);
			} catch (error) {
				console.warn('[reader-tap-zones] two-finger tap callback failed:', error);
			}
		}
	}

	function attach(doc: Document): () => void {
		const state = createDocTapState();

		const clearLongPressTimer = () => {
			if (state.longPressTimer) {
				window.clearTimeout(state.longPressTimer);
				state.longPressTimer = null;
			}
		};

		const resetGesture = () => {
			state.startPoints.clear();
			state.pointerCount = 0;
			state.peakPointers = 0;
			state.moved = false;
			state.longPressed = false;
			state.suppressGesture = false;
			clearLongPressTimer();
		};

		const onSelectionChange = () => {
			const active = hasActiveSelection(doc);
			if (active) {
				state.lastSelectionActiveAt = performance.now();
				state.selectionOpen = true;
			} else if (state.selectionOpen) {
				// 从「有选区」变为「收起/清空」：记录本次收起时刻。
				// 收起后的下一次点按=取消选中（不翻页），若依赖 lastSelectionActiveAt 的 600ms 窗口，
				// 用户选词后停顿几秒再点就会漏判误翻页——这是持久状态的原因。
				state.selectionOpen = false;
				state.selectionClosedAt = performance.now();
			}
		};

		const onTouchStart = (event: TouchEvent) => {
			for (const touch of Array.from(event.changedTouches || [])) {
				state.startPoints.set(touch.identifier, {
					x: touch.clientX,
					y: touch.clientY,
				});
			}
			state.pointerCount = event.touches?.length ?? state.pointerCount + (event.changedTouches?.length ?? 0);
			state.peakPointers = Math.max(state.peakPointers, state.pointerCount);
			// 有选区（含未收起的持久状态）时，本盘点按=收起选区（取消选中），不参与翻页。
			state.suppressGesture = hasActiveSelection(doc) || state.selectionOpen === true;
			if (state.pointerCount === 1) {
				if (!state.longPressTimer) {
					state.longPressTimer = window.setTimeout(() => {
						state.longPressed = true;
					}, TAP_LONG_PRESS_MS);
				}
			} else {
				// 多指手势：长按语义只对单指有效，取消长按计时。
				clearLongPressTimer();
			}
		};

		const onTouchMove = (event: TouchEvent) => {
			for (const touch of Array.from(event.changedTouches || [])) {
				const start = state.startPoints.get(touch.identifier);
				if (!start) {
					continue;
				}
				const dx = touch.clientX - start.x;
				const dy = touch.clientY - start.y;
				if (Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE_PX) {
					state.moved = true;
					clearLongPressTimer();
					break;
				}
			}
		};

		const onTouchEnd = (event: TouchEvent) => {
			const remaining = event.touches?.length ?? 0;
			const changedTouches = Array.from(event.changedTouches || []);
			for (const touch of changedTouches) {
				state.startPoints.delete(touch.identifier);
			}
			state.pointerCount = remaining;
			// 仍有手指按着：手势未结束，等待最后一次抬起。
			if (remaining > 0) {
				return;
			}

			clearLongPressTimer();
			const peakPointers = state.peakPointers;
			const moved = state.moved;
			const longPressed = state.longPressed;
			const suppressGesture = state.suppressGesture;
			const now = performance.now();
			resetGesture();

			if (!enabled) {
				return;
			}
			if (moved || longPressed) {
				return;
			}

			const lift = changedTouches[0];
			if (!lift) {
				return;
			}

			if (peakPointers === 2) {
				// 双指轻点：切换全屏等手势，不参与翻页。双指手势不拦截链接/标注等单指语义。
				emitTwoFingerTap({
					clientX: lift.clientX,
					clientY: lift.clientY,
					timeStamp: event.timeStamp,
				});
				return;
			}
			if (peakPointers !== 1) {
				// 三指及以上：不响应。
				return;
			}

			if (suppressGesture) {
				return;
			}
			if (hasActiveSelection(doc)) {
				return;
			}
			// 刚刚收起过文字选区（selectionchange 从有到无）：
			// 本盘点按=取消选中，不得翻页（不依赖旧的时间窗，避免选词后停顿再点被误判）。
			if (state.selectionClosedAt > 0 && now - state.selectionClosedAt < TAP_RECENT_SELECTION_MS) {
				return;
			}
			if (performance.now() - state.lastSelectionActiveAt < TAP_RECENT_SELECTION_MS) {
				return;
			}
			if (isInteractiveTarget(event.target)) {
				return;
			}
			if (shouldBlockTap?.({ x: lift.clientX, y: lift.clientY }, doc)) {
				return;
			}
			const frameHeight = getFrameViewportHeight(doc);
			const tapEvent: ReaderTapEvent = {
				zone: resolveTapZone(lift.clientY, frameHeight),
				clientX: lift.clientX,
				clientY: lift.clientY,
				frameHeight,
				timeStamp: event.timeStamp,
			};
			// 单击立即翻页（无防抖延迟）。选中态与交互元素已在上面分支拦截。
			emit(tapEvent);
		};

		const onTouchCancel = () => {
			resetGesture();
		};

		doc.addEventListener('touchstart', onTouchStart, { passive: true });
		doc.addEventListener('touchmove', onTouchMove, { passive: true });
		doc.addEventListener('touchend', onTouchEnd, { passive: true });
		doc.addEventListener('touchcancel', onTouchCancel, { passive: true });
		doc.addEventListener('selectionchange', onSelectionChange);

		return () => {
			clearLongPressTimer();
			doc.removeEventListener('touchstart', onTouchStart);
			doc.removeEventListener('touchmove', onTouchMove);
			doc.removeEventListener('touchend', onTouchEnd);
			doc.removeEventListener('touchcancel', onTouchCancel);
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
		onTwoFingerTap(callback) {
			twoFingerTapCallbacks.add(callback);
			return () => {
				twoFingerTapCallbacks.delete(callback);
			};
		},
		dispose() {
			tapCallbacks.clear();
			twoFingerTapCallbacks.clear();
		},
	};
}