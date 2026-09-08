import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MOBILE_PAGE_ARROW_DRAG_SLOP_PX,
	MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
	MOBILE_PAGE_ARROW_LONG_PRESS_MS,
	clampArrowPosition,
	createArrowGestureController,
	getDefaultArrowPosition,
	positionFromRatio,
	positionToRatio,
} from './mobile-page-arrows';

describe('mobile-page-arrows 定位计算', () => {
	const size = { width: 48, height: 96 };
	const viewport = { width: 400, height: 800 };

	it('默认位置在左下角（留边缘间距）', () => {
		const pos = getDefaultArrowPosition(size, viewport);
		expect(pos.x).toBe(MOBILE_PAGE_ARROW_EDGE_MARGIN_PX);
		expect(pos.y).toBe(800 - 96 - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX);
	});

	it('clamp 把越界点收回视口内', () => {
		expect(clampArrowPosition({ x: -50, y: -50 }, size, viewport)).toEqual({
			x: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
			y: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
		});
		expect(clampArrowPosition({ x: 9999, y: 9999 }, size, viewport)).toEqual({
			x: 400 - 48 - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
			y: 800 - 96 - MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
		});
	});

	it('视口比箭头还小时 clamp 不产生负坐标', () => {
		const tiny = { width: 20, height: 30 };
		expect(clampArrowPosition({ x: 5, y: 5 }, size, tiny)).toEqual({
			x: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
			y: MOBILE_PAGE_ARROW_EDGE_MARGIN_PX,
		});
	});

	it('ratio 往返转换保持位置，且越界 ratio 被 clamp', () => {
		const pos = { x: 120, y: 300 };
		const ratio = positionToRatio(pos, size, viewport);
		expect(positionFromRatio(ratio, size, viewport)).toEqual(pos);

		expect(positionFromRatio({ xRatio: 5, yRatio: -3 }, size, viewport)).toEqual(
			clampArrowPosition(
				positionFromRatio({ xRatio: 1, yRatio: 0 }, size, viewport),
				size,
				viewport
			)
		);
		expect(positionToRatio({ x: -999, y: 99999 }, size, viewport)).toEqual({
			xRatio: 0,
			yRatio: 1,
		});
	});
});

describe('mobile-page-arrows 手势状态机', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createController(overrides?: Partial<Parameters<typeof createArrowGestureController>[0]>) {
		const events: string[] = [];
		const controller = createArrowGestureController({
			onTap: (dir) => events.push(`tap:${dir}`),
			onDragStart: () => events.push('dragStart'),
			onDragMove: () => events.push('dragMove'),
			onDragEnd: () => events.push('dragEnd'),
			...overrides,
		});
		return { controller, events };
	}

	it('快速单击（未达长按、未位移）触发 tap', () => {
		const { controller, events } = createController();
		controller.onDown('prev', { x: 10, y: 10 });
		controller.onUp();
		expect(events).toEqual(['tap:prev']);
	});

	it('按住超过长按时长进入拖动，随后移动与松手依次回调', () => {
		const { controller, events } = createController();
		controller.onDown('next', { x: 10, y: 10 });
		vi.advanceTimersByTime(MOBILE_PAGE_ARROW_LONG_PRESS_MS + 1);
		expect(events).toEqual(['dragStart']);
		controller.onMove({ x: 30, y: 60 });
		controller.onUp();
		expect(events).toEqual(['dragStart', 'dragMove', 'dragEnd']);
	});

	it('未达长按就滑动 = 无操作（既不 tap 也不拖动）', () => {
		const { controller, events } = createController();
		controller.onDown('prev', { x: 10, y: 10 });
		controller.onMove({ x: 10 + MOBILE_PAGE_ARROW_DRAG_SLOP_PX + 5, y: 10 });
		controller.onUp();
		expect(events).toEqual([]);
	});

	it('长按后松手不触发 tap', () => {
		const { controller, events } = createController();
		controller.onDown('prev', { x: 0, y: 0 });
		vi.advanceTimersByTime(MOBILE_PAGE_ARROW_LONG_PRESS_MS + 1);
		controller.onUp();
		expect(events).toEqual(['dragStart', 'dragEnd']);
	});

	it('位移在 slop 阈值内不取消单击', () => {
		const { controller, events } = createController();
		controller.onDown('next', { x: 10, y: 10 });
		controller.onMove({ x: 10 + MOBILE_PAGE_ARROW_DRAG_SLOP_PX - 1, y: 10 });
		controller.onUp();
		expect(events).toEqual(['tap:next']);
	});

	it('pointercancel 在拖动中结束拖动、在按压中静默取消', () => {
		const { controller, events } = createController();
		controller.onDown('prev', { x: 0, y: 0 });
		vi.advanceTimersByTime(MOBILE_PAGE_ARROW_LONG_PRESS_MS + 1);
		controller.onCancel();
		expect(events).toEqual(['dragStart', 'dragEnd']);

		const second = createController();
		second.controller.onDown('prev', { x: 0, y: 0 });
		second.controller.onCancel();
		expect(second.events).toEqual([]);
	});
});
