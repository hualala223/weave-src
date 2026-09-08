/**
 * 移动端翻页箭头的纯逻辑缝：定位计算 + 手势状态机。
 * 不依赖 DOM，便于单测（先例：toolbar-positioning / excerpt-display-order）。
 */

import type { EpubPageArrowPosition } from '../../services/epub/types';

export const MOBILE_PAGE_ARROW_LONG_PRESS_MS = 450;
export const MOBILE_PAGE_ARROW_DRAG_SLOP_PX = 10;
export const MOBILE_PAGE_ARROW_EDGE_MARGIN_PX = 14;

export interface MobileArrowPoint {
	x: number;
	y: number;
}

export interface MobileArrowSize {
	width: number;
	height: number;
}

export interface MobileArrowViewport {
	width: number;
	height: number;
}

/** 停放位置与设置层共用同一形状（比例，跨设备/旋屏稳定）。 */
export type MobileArrowPositionRatio = EpubPageArrowPosition;

export type MobileArrowDirection = 'prev' | 'next';

/** 自由停放范围：视口尺寸减去箭头组自身与两侧边缘间距。 */
function getFreeSpan(length: number, arrowLength: number): number {
	return Math.max(0, length - arrowLength - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX * 2);
}

export function clampArrowPosition(
	point: MobileArrowPoint,
	size: MobileArrowSize,
	viewport: MobileArrowViewport
): MobileArrowPoint {
	const maxX = MOBILE_PAGE_ARROW_EDGE_MARGIN_PX + getFreeSpan(viewport.width, size.width);
	const maxY = MOBILE_PAGE_ARROW_EDGE_MARGIN_PX + getFreeSpan(viewport.height, size.height);
	return {
		x: Math.min(Math.max(point.x, MOBILE_PAGE_ARROW_EDGE_MARGIN_PX), maxX),
		y: Math.min(Math.max(point.y, MOBILE_PAGE_ARROW_EDGE_MARGIN_PX), maxY),
	};
}

/** 未拖过时的默认位置：左下角（单手持机拇指易达）。 */
export function getDefaultArrowPosition(
	size: MobileArrowSize,
	viewport: MobileArrowViewport
): MobileArrowPoint {
	return {
		x: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
		y: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX + getFreeSpan(viewport.height, size.height),
	};
}

/** 位置 ↔ 比例：以毫米级像素存设置会跨设备/旋屏失真，按自由区间的比例存。 */
export function positionToRatio(
	point: MobileArrowPoint,
	size: MobileArrowSize,
	viewport: MobileArrowViewport
): MobileArrowPositionRatio {
	const freeWidth = getFreeSpan(viewport.width, size.width);
	const freeHeight = getFreeSpan(viewport.height, size.height);
	const xRatio = freeWidth > 0 ? (point.x - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX) / freeWidth : 0;
	const yRatio = freeHeight > 0 ? (point.y - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX) / freeHeight : 0;
	return {
		xRatio: Math.min(1, Math.max(0, xRatio)),
		yRatio: Math.min(1, Math.max(0, yRatio)),
	};
}

export function positionFromRatio(
	ratio: MobileArrowPositionRatio,
	size: MobileArrowSize,
	viewport: MobileArrowViewport
): MobileArrowPoint {
	const xRatio = Number.isFinite(ratio?.xRatio) ? Math.min(1, Math.max(0, ratio.xRatio)) : 0;
	const yRatio = Number.isFinite(ratio?.yRatio) ? Math.min(1, Math.max(0, ratio.yRatio)) : 0;
	return clampArrowPosition(
		{
			x:
				MOBILE_PAGE_ARROW_EDGE_MARGIN_PX +
				xRatio * getFreeSpan(viewport.width, size.width),
			y:
				MOBILE_PAGE_ARROW_EDGE_MARGIN_PX +
				yRatio * getFreeSpan(viewport.height, size.height),
		},
		size,
		viewport
	);
}

export interface ArrowGestureCallbacks {
	onTap: (direction: MobileArrowDirection) => void;
	onDragStart: () => void;
	onDragMove: () => void;
	onDragEnd: () => void;
	longPressMs?: number;
	slopPx?: number;
}

export type ArrowGesturePhase = 'idle' | 'pressed' | 'dragging' | 'dismissed';

/**
 * 单击 / 长按拖动 / 误滑三分的状态机（规格 Q5/Q10）：
 * - 按下后未达长按时长松手且位移未超阈值 → tap（翻页）；
 * - 按下达长按时长 → 进入拖动态，之后移动/松手走 drag 回调；
 * - 未达长按就滑出阈值 → dismissed，松手不做任何事。
 */
export function createArrowGestureController(callbacks: ArrowGestureCallbacks) {
	const longPressMs = callbacks.longPressMs ?? MOBILE_PAGE_ARROW_LONG_PRESS_MS;
	const slopPx = callbacks.slopPx ?? MOBILE_PAGE_ARROW_DRAG_SLOP_PX;
	let phase: ArrowGesturePhase = 'idle';
	let direction: MobileArrowDirection = 'prev';
	let startPoint: MobileArrowPoint = { x: 0, y: 0 };
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;

	function clearLongPressTimer() {
		if (longPressTimer !== null) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	function resetPhase(next: ArrowGesturePhase) {
		clearLongPressTimer();
		phase = next;
	}

	return {
		get phase() {
			return phase;
		},
		onDown(nextDirection: MobileArrowDirection, point: MobileArrowPoint) {
			resetPhase('pressed');
			direction = nextDirection;
			startPoint = point;
			longPressTimer = setTimeout(() => {
				longPressTimer = null;
				if (phase !== 'pressed') {
					return;
				}
				phase = 'dragging';
				callbacks.onDragStart();
			}, longPressMs);
		},
		onMove(point: MobileArrowPoint) {
			if (phase === 'pressed') {
				const dx = point.x - startPoint.x;
				const dy = point.y - startPoint.y;
				if (Math.hypot(dx, dy) > slopPx) {
					resetPhase('dismissed');
				}
				return;
			}
			if (phase === 'dragging') {
				callbacks.onDragMove();
			}
		},
		onUp() {
			if (phase === 'pressed') {
				resetPhase('idle');
				callbacks.onTap(direction);
				return;
			}
			if (phase === 'dragging') {
				resetPhase('idle');
				callbacks.onDragEnd();
				return;
			}
			resetPhase('idle');
		},
		onCancel() {
			if (phase === 'dragging') {
				resetPhase('idle');
				callbacks.onDragEnd();
				return;
			}
			resetPhase('idle');
		},
		destroy() {
			resetPhase('idle');
		},
	};
}
