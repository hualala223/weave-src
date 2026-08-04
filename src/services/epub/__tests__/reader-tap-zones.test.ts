import { describe, expect, it } from 'vitest';
import {
	createTapBurstTracker,
	resolveTapZone,
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

describe('createTapBurstTracker', () => {
	it('时间窗内连击递增，超窗重置', () => {
		const tracker = createTapBurstTracker({ windowMs: 300 });
		expect(tracker.push({ time: 0 })).toBe(1);
		expect(tracker.push({ time: 100 })).toBe(2);
		expect(tracker.push({ time: 200 })).toBe(3);
		// 超过窗口 → 新一轮
		expect(tracker.push({ time: 600 })).toBe(1);
	});

	it('reset 清空连击', () => {
		const tracker = createTapBurstTracker({ windowMs: 300 });
		tracker.push({ time: 0 });
		tracker.push({ time: 100 });
		tracker.reset();
		expect(tracker.push({ time: 150 })).toBe(1);
	});

	it('时间戳缺失按新连击处理', () => {
		const tracker = createTapBurstTracker({ windowMs: 300 });
		expect(tracker.push({ time: Number.NaN })).toBe(1);
	});

	it('任意位置快速连击均计入（三连击不要求同点）', () => {
		const tracker = createTapBurstTracker({ windowMs: 300 });
		expect(tracker.push({ time: 0 })).toBe(1);
		expect(tracker.push({ time: 100 })).toBe(2); // 不同位置
		expect(tracker.push({ time: 200 })).toBe(3);
	});
});
