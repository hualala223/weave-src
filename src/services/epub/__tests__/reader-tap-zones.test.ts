import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createReaderTapZoneController,
	resolveTapZone,
	TAP_MOVE_TOLERANCE_PX,
	TAP_ZONE_PREV_RATIO,
} from '../reader-tap-zones';

describe('resolveTapZone', () => {
	it('上方 40% 区域为上一页', () => {
		const height = 1000;
		const boundary = height * TAP_ZONE_PREV_RATIO;
		expect(resolveTapZone(0, height)).toBe('prev');
		expect(resolveTapZone(boundary - 1, height)).toBe('prev');
	});

	it('下方 60% 区域为下一页', () => {
		const height = 1000;
		const boundary = height * TAP_ZONE_PREV_RATIO;
		expect(resolveTapZone(boundary, height)).toBe('next');
		expect(resolveTapZone(height - 1, height)).toBe('next');
	});

	it('非法输入回退到下一页', () => {
		expect(resolveTapZone(Number.NaN, 1000)).toBe('next');
		expect(resolveTapZone(100, 0)).toBe('next');
		expect(resolveTapZone(100, Number.NaN)).toBe('next');
	});
});

interface SyntheticTouch {
	identifier: number;
	clientX: number;
	clientY: number;
}

function createTouchEvent(
	type: string,
	touches: SyntheticTouch[],
	changedTouches: SyntheticTouch[]
): Event {
	const event = new Event(type) as Event & { touches: SyntheticTouch[]; changedTouches: SyntheticTouch[] };
	Object.defineProperty(event, 'touches', { value: touches, configurable: true });
	Object.defineProperty(event, 'changedTouches', { value: changedTouches, configurable: true });
	return event;
}

describe('createReaderTapZoneController', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		vi.useFakeTimers();
		const controller = createReaderTapZoneController();
		controller.setEnabled(true);
		const off = controller.attach(document);
		const onTap = vi.fn();
		const onTwoFingerTap = vi.fn();
		controller.onTap(onTap);
		controller.onTwoFingerTap(onTwoFingerTap);
		return { controller, off, onTap, onTwoFingerTap };
	}

	function dispatch(type: string, touches: SyntheticTouch[], changedTouches: SyntheticTouch[]): void {
		document.dispatchEvent(createTouchEvent(type, touches, changedTouches));
	}

	it('单指轻点：立即触发 onTap（无防抖/双击延迟）且不触发双指事件', () => {
		const { off, onTap, onTwoFingerTap } = setup();

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 700 }], [
			{ identifier: 1, clientX: 10, clientY: 700 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 700 }]);

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onTap.mock.calls[0][0].zone).toBe('next');
		expect(onTwoFingerTap).not.toHaveBeenCalled();
		off();
	});

	it('选词后停顿远超时间窗：存在未收起选区时点按不翻页（持久选区状态，不依赖 600ms 时间窗）', () => {
		const { off, onTap } = setup();

		// 选词：形成非折叠选区（selectionOpen = true）
		const fakeSelection = { rangeCount: 1, isCollapsed: false } as unknown as Selection;
		vi.spyOn(document, 'getSelection').mockReturnValue(fakeSelection);
		document.dispatchEvent(new Event('selectionchange'));

		// 停顿远超旧时间窗：旧逻辑此时已误判为「可翻页」，修复后仍应不翻页
		vi.advanceTimersByTime(3000);

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 700 }], [
			{ identifier: 1, clientX: 10, clientY: 700 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 700 }]);

		vi.restoreAllMocks();
		expect(onTap).not.toHaveBeenCalled();
		off();
	});

	it('选区收起后紧接着点按：不翻页（把「收起选区」的点击当作取消选中而非翻页）', () => {
		const { off, onTap } = setup();

		// 选词 → 选区被收起（selectionchange 从有到无，记录 selectionClosedAt）
		const withSelection = { rangeCount: 1, isCollapsed: false } as unknown as Selection;
		const withoutSelection = { rangeCount: 0, isCollapsed: true } as unknown as Selection;
		const spy = vi.spyOn(document, 'getSelection');
		spy.mockReturnValue(withSelection);
		document.dispatchEvent(new Event('selectionchange'));
		spy.mockReturnValue(withoutSelection);
		document.dispatchEvent(new Event('selectionchange'));

		// 收起后紧接着点按（仍在 selectionClosedAt 窗口内），不应翻页
		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 700 }], [
			{ identifier: 1, clientX: 10, clientY: 700 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 700 }]);

		vi.restoreAllMocks();
		expect(onTap).not.toHaveBeenCalled();
		off();
	});

	it('双指同时按下抬起触发 onTwoFingerTap 且不触发 onTap', () => {
		const { off, onTap, onTwoFingerTap } = setup();

		dispatch('touchstart', [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		], [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);
		dispatch('touchend', [], [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);

		expect(onTwoFingerTap).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		off();
	});

	it('先后落指的双指轻点（峰值两指）同样触发双指事件', () => {
		const { off, onTap, onTwoFingerTap } = setup();

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 10 }], [
			{ identifier: 1, clientX: 10, clientY: 10 },
		]);
		dispatch('touchstart', [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		], [
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);
		// 第二指先抬（还剩一指），手势未结束，不应触发
		dispatch('touchend', [{ identifier: 1, clientX: 10, clientY: 10 }], [
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);
		expect(onTwoFingerTap).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
		// 第一指抬起，手势结束（峰值两指）
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 10 }]);

		expect(onTwoFingerTap).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		off();
	});

	it('双指带位移（超出容差）不触发任何事件', () => {
		const { off, onTap, onTwoFingerTap } = setup();

		dispatch('touchstart', [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		], [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);
		dispatch('touchmove', [
			{ identifier: 1, clientX: 10 + TAP_MOVE_TOLERANCE_PX + 1, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		], [
			{ identifier: 1, clientX: 10 + TAP_MOVE_TOLERANCE_PX + 1, clientY: 10 },
		]);
		dispatch('touchend', [], [
			{ identifier: 1, clientX: 10 + TAP_MOVE_TOLERANCE_PX + 1, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);

		expect(onTwoFingerTap).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
		off();
	});

	it('禁用时不触发任何事件', () => {
		const { controller, off, onTap, onTwoFingerTap } = setup();
		controller.setEnabled(false);

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 10 }], [
			{ identifier: 1, clientX: 10, clientY: 10 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 10 }]);
		dispatch('touchstart', [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		], [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);
		dispatch('touchend', [], [
			{ identifier: 1, clientX: 10, clientY: 10 },
			{ identifier: 2, clientX: 40, clientY: 30 },
		]);

		// 已禁用：立即触发与否都不应产生回调
		expect(onTap).not.toHaveBeenCalled();
		expect(onTwoFingerTap).not.toHaveBeenCalled();
		off();
	});

	it('shouldBlockTap 命中时不触发翻页（脚注弹窗已固定等场景）', () => {
		vi.useFakeTimers();
		const shouldBlockTap = vi.fn().mockReturnValue(true);
		const controller = createReaderTapZoneController({ shouldBlockTap });
		controller.setEnabled(true);
		const off = controller.attach(document);
		const onTap = vi.fn();
		const onTwoFingerTap = vi.fn();
		controller.onTap(onTap);
		controller.onTwoFingerTap(onTwoFingerTap);

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 700 }], [
			{ identifier: 1, clientX: 10, clientY: 700 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 700 }]);

		expect(shouldBlockTap).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		expect(onTwoFingerTap).not.toHaveBeenCalled();
		off();
	});

	it('shouldBlockTap 未命中时正常触发翻页', () => {
		vi.useFakeTimers();
		const shouldBlockTap = vi.fn().mockReturnValue(false);
		const controller = createReaderTapZoneController({ shouldBlockTap });
		controller.setEnabled(true);
		const off = controller.attach(document);
		const onTap = vi.fn();
		controller.onTap(onTap);

		dispatch('touchstart', [{ identifier: 1, clientX: 10, clientY: 700 }], [
			{ identifier: 1, clientX: 10, clientY: 700 },
		]);
		dispatch('touchend', [], [{ identifier: 1, clientX: 10, clientY: 700 }]);

		expect(onTap).toHaveBeenCalledTimes(1);
		off();
	});
});