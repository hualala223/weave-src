import {
	collectSelectionRects,
	computeToolbarPosition,
	createEventBinder,
	decideSelectionPointerGuard,
	estimateNativeSelectionMenuSide,
	isEventInsideObsidianFloatingUi,
	isEventOutsideToolbar,
	mirrorFloatingSide,
	resolveMobileFloatingInsetBottom,
	shouldDismissToolbarOnPointerDown,
} from './toolbar-positioning';

describe('toolbar-positioning', () => {
	it('floats mobile toolbars below the selection when the native menu stays above', () => {
		const anchorRect = { top: 80, left: 40, bottom: 96, right: 96, width: 56, height: 16 };
		const result = computeToolbarPosition({
			anchorRect,
			containerWidth: 320,
			containerHeight: 480,
			toolbarWidth: 280,
			toolbarHeight: 72,
			mobile: true,
		});

		expect(estimateNativeSelectionMenuSide(anchorRect, 480)).toBe('above');
		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(true);
		expect(result.top).toBe(108);
		expect(result.left).toBe(12);
		expect(result.anchorRect).toEqual(anchorRect);
	});

	it('floats mobile toolbars below the selection when the native menu stays above', () => {
		const anchorRect = { top: 120, left: 140, bottom: 144, right: 204, width: 64, height: 24 };
		const result = computeToolbarPosition({
			anchorRect,
			containerWidth: 390,
			containerHeight: 720,
			toolbarWidth: 220,
			toolbarHeight: 72,
			mobile: true,
		});

		expect(estimateNativeSelectionMenuSide(anchorRect, 720)).toBe('above');
		expect(mirrorFloatingSide('above')).toBe('bottom');
		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(true);
		expect(result.top).toBe(156);
		expect(result.left).toBe(62);
	});

	it('docks mobile toolbars when the native menu flips below near the top edge', () => {
		const anchorRect = { top: 8, left: 40, bottom: 24, right: 96, width: 56, height: 16 };
		const result = computeToolbarPosition({
			anchorRect,
			containerWidth: 320,
			containerHeight: 480,
			toolbarWidth: 220,
			toolbarHeight: 72,
			mobile: true,
		});

		expect(estimateNativeSelectionMenuSide(anchorRect, 480)).toBe('below');
		expect(mirrorFloatingSide('below')).toBe('top');
		expect(result.mode).toBe('docked');
	});

	it('docks mobile toolbars when floating would overlap the selection', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 10, left: 40, bottom: 25, right: 96, width: 56, height: 15 },
			containerWidth: 320,
			containerHeight: 100,
			toolbarWidth: 280,
			toolbarHeight: 72,
			mobile: true,
		});

		expect(result.mode).toBe('docked');
		expect(result.top).toBe(0);
		expect(result.left).toBe(12);
		expect(result.arrowOffset).toBe(0);
	});

	it('docks mobile toolbars when the mirrored side lacks room', () => {
		const anchorRect = { top: 360, left: 40, bottom: 376, right: 96, width: 56, height: 16 };
		const result = computeToolbarPosition({
			anchorRect,
			containerWidth: 320,
			containerHeight: 400,
			toolbarWidth: 220,
			toolbarHeight: 72,
			mobile: true,
			insetBottom: resolveMobileFloatingInsetBottom(56),
		});

		expect(estimateNativeSelectionMenuSide(anchorRect, 400)).toBe('above');
		expect(result.mode).toBe('docked');
	});

	it('flips below when the selection sits in the upper half (more room below)', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 120, left: 100, bottom: 144, right: 164, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 280,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(true);
		expect(result.top).toBe(156);
		expect(result.left).toBe(62);
		expect(result.arrowOffset).toBe(0);
	});

	it('stays above when the selection sits in the lower half (more room above)', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 168, left: 100, bottom: 192, right: 164, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 280,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(96);
		expect(result.left).toBe(62);
		expect(result.arrowOffset).toBe(0);
	});

	it('stays above when clearance is exactly tied (default preferred side)', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 148, left: 100, bottom: 172, right: 164, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 320,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(76);
		expect(result.left).toBe(62);
	});

	it('breaks an exact tie downward when preferredSide is bottom', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 148, left: 100, bottom: 172, right: 164, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 320,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
			preferredSide: 'bottom',
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(true);
		expect(result.top).toBe(184);
	});

	it('places above exclusively when only the above side fits', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 150, left: 40, bottom: 174, right: 96, width: 56, height: 24 },
			containerWidth: 240,
			containerHeight: 240,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(78);
		expect(result.left).toBe(12);
		expect(result.arrowOffset).toBe(-14);
	});

	it('treats clearance exactly equal to toolbar height as usable (boundary)', () => {
		// 上方净空 == 工具条高度（60），刚够放得下 → 可用即选上方，零重叠（>= 边界）
		const result = computeToolbarPosition({
			anchorRect: { top: 84, left: 100, bottom: 108, right: 164, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 180,
			toolbarWidth: 140,
			toolbarHeight: 60,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(12);
	});

	it('overlaps minimally with clamped placement when neither side fits (larger clearance side)', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 60, left: 40, bottom: 160, right: 96, width: 56, height: 100 },
			containerWidth: 320,
			containerHeight: 200,
			toolbarWidth: 220,
			toolbarHeight: 72,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		// 上方净空 36 > 下方净空 16 → 取上方，钳制在容器顶部
		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(12);
		// 最小重叠由构造保证：工具条 12–84 侵入选区 24px（84−60）；
		// 若取对侧（下方）会钳至 116–188，侵入 44px——选中的正是侵入更小的一侧。
		expect(result.top + 72).toBeGreaterThan(60);
	});

	it('overlaps minimally below when neither side fits and below has more clearance', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 20, left: 40, bottom: 170, right: 96, width: 56, height: 150 },
			containerWidth: 320,
			containerHeight: 200,
			toolbarWidth: 220,
			toolbarHeight: 72,
			mobile: false,
		});

		expect(result.mode).toBe('floating');
		// 下方净空 6 > 上方净空 -4 → 取下方，钳制在容器底部可用区
		expect(result.isBelowAnchor).toBe(true);
		expect(result.top).toBe(116);
		// 最小重叠由构造保证：工具条 116–188 侵入选区 54px（170−116）；
		// 若取对侧（上方）会钳至 12–84，侵入 64px——选中的正是侵入更小的一侧。
		expect(result.top).toBeLessThan(170);
	});

	it('flips below and clamps arrow offset near viewport edges', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 18, left: 8, bottom: 34, right: 40, width: 32, height: 16 },
			containerWidth: 240,
			containerHeight: 180,
			toolbarWidth: 120,
			toolbarHeight: 56,
			mobile: false,
		});

		expect(result.isBelowAnchor).toBe(true);
		expect(result.left).toBe(12);
		expect(result.top).toBe(46);
		expect(result.arrowOffset).toBe(-42);
	});

	it('chooses the top-most line rect for multi-line selections when only the above side fits', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 150, left: 24, bottom: 222, right: 212, width: 188, height: 72 },
			anchorRects: [
				{ top: 150, left: 120, bottom: 174, right: 212, width: 92, height: 24 },
				{ top: 198, left: 24, bottom: 222, right: 116, width: 92, height: 24 },
			],
			containerWidth: 320,
			containerHeight: 260,
			toolbarWidth: 120,
			toolbarHeight: 56,
			mobile: false,
		});

		expect(result.isBelowAnchor).toBe(false);
		expect(result.anchorRect).toEqual({ top: 150, left: 120, bottom: 174, right: 212, width: 92, height: 24 });
		expect(result.top).toBe(82);
		expect(result.left).toBe(106);
		expect(result.arrowOffset).toBe(0);
	});

	it('chooses the bottom-most line rect and anchor point when only the below side fits', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 48, left: 32, bottom: 136, right: 196, width: 164, height: 88 },
			anchorRects: [
				{ top: 48, left: 32, bottom: 72, right: 164, width: 132, height: 24 },
				{ top: 112, left: 84, bottom: 136, right: 196, width: 112, height: 24 },
			],
			anchorPoint: { x: 180, y: 124 },
			containerWidth: 320,
			containerHeight: 260,
			toolbarWidth: 140,
			toolbarHeight: 72,
			mobile: false,
			preferredSide: 'bottom',
		});

		expect(result.isBelowAnchor).toBe(true);
		expect(result.anchorRect).toEqual({ top: 112, left: 84, bottom: 136, right: 196, width: 112, height: 24 });
		expect(result.left).toBe(110);
		expect(result.top).toBe(148);
		expect(result.arrowOffset).toBe(0);
	});

	it('keeps floating toolbars above reserved bottom insets', () => {
		const result = computeToolbarPosition({
			anchorRect: { top: 220, left: 110, bottom: 244, right: 174, width: 64, height: 24 },
			containerWidth: 360,
			containerHeight: 320,
			toolbarWidth: 160,
			toolbarHeight: 72,
			mobile: false,
			insetBottom: 68,
		});

		expect(result.isBelowAnchor).toBe(false);
		expect(result.top).toBe(136);
	});

	it('disposes bound listeners together', () => {
		const binder = createEventBinder();
		const target = document.createElement('div');
		const handler = vi.fn();

		binder.bind(target, 'click', handler);
		target.dispatchEvent(new Event('click'));
		expect(handler).toHaveBeenCalledTimes(1);

		binder.dispose();
		target.dispatchEvent(new Event('click'));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('detects outside toolbar events', () => {
		const toolbar = document.createElement('div');
		const child = document.createElement('button');
		toolbar.appendChild(child);
		document.body.appendChild(toolbar);
		const outside = document.createElement('div');
		document.body.appendChild(outside);

		const insideEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(insideEvent, 'target', { value: child });
		expect(isEventOutsideToolbar(toolbar, insideEvent)).toBe(false);

		const outsideEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(outsideEvent, 'target', { value: outside });
		expect(isEventOutsideToolbar(toolbar, outsideEvent)).toBe(true);

		expect(isEventOutsideToolbar(undefined, outsideEvent)).toBe(false);
	});

	it('treats Obsidian menus as inside floating UI', () => {
		const menu = document.createElement('div');
		menu.className = 'menu';
		const item = document.createElement('div');
		menu.appendChild(item);
		document.body.appendChild(menu);

		const menuEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(menuEvent, 'target', { value: item });
		expect(isEventInsideObsidianFloatingUi(menuEvent)).toBe(true);
	});

	it('dismisses toolbar on outside pointer down but not on menu clicks', () => {
		const toolbar = document.createElement('div');
		const button = document.createElement('button');
		toolbar.appendChild(button);
		document.body.appendChild(toolbar);

		const menu = document.createElement('div');
		menu.className = 'menu';
		const menuItem = document.createElement('div');
		menu.appendChild(menuItem);
		document.body.appendChild(menu);

		const outside = document.createElement('div');
		document.body.appendChild(outside);

		const toolbarEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(toolbarEvent, 'target', { value: button });
		expect(shouldDismissToolbarOnPointerDown(toolbar, toolbarEvent)).toBe(false);

		const menuEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(menuEvent, 'target', { value: menuItem });
		expect(shouldDismissToolbarOnPointerDown(toolbar, menuEvent)).toBe(false);

		const outsideEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(outsideEvent, 'target', { value: outside });
		expect(shouldDismissToolbarOnPointerDown(toolbar, outsideEvent)).toBe(true);
	});

	it('dismisses toolbar for pointer targets inside EPUB iframe documents', () => {
		const toolbar = document.createElement('div');
		document.body.appendChild(toolbar);

		const iframe = document.createElement('iframe');
		document.body.appendChild(iframe);
		const iframeDoc = iframe.contentDocument;
		expect(iframeDoc).toBeTruthy();
		const insideIframe = iframeDoc!.createElement('p');
		iframeDoc!.body.appendChild(insideIframe);

		const iframeEvent = new MouseEvent('mousedown', { bubbles: true });
		Object.defineProperty(iframeEvent, 'target', { value: insideIframe });
		expect(shouldDismissToolbarOnPointerDown(toolbar, iframeEvent)).toBe(true);
	});
});

describe('decideSelectionPointerGuard (移动端坐标感知选区守卫)', () => {
	function rect(left: number, top: number, right: number, bottom: number) {
		return { left, top, right, bottom };
	}

	it('非移动端一律取消（守卫生效范围仅限移动端）', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: false,
				hasNonCollapsedSelection: true,
				point: { x: 50, y: 60 },
				selectionRects: [rect(0, 0, 100, 100)],
				handleTolerance: 4,
			})
		).toBe('cancel');
	});

	it('移动端但无选区 → 取消', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: false,
				point: { x: 50, y: 60 },
				selectionRects: [rect(0, 0, 100, 100)],
				handleTolerance: 4,
			})
		).toBe('cancel');
	});

	it('移动端 + 有选区 + 坐标不可用时保守旁观（维持旧行为）', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: null,
				selectionRects: [rect(0, 0, 100, 100)],
				handleTolerance: 4,
			})
		).toBe('standby');
	});

	it('点按落在选区矩形内 → 旁观', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 50, y: 60 },
				selectionRects: [rect(10, 20, 90, 120)],
				handleTolerance: 4,
			})
		).toBe('standby');
	});

	it('点按刚越出选区但仍在手柄容差内 → 旁观（保护拖选手柄起点）', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 94, y: 20 },
				selectionRects: [rect(10, 20, 90, 120)],
				handleTolerance: 8,
			})
		).toBe('standby');
	});

	it('点按明显在选区矩形外 → 取消', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 140, y: 20 },
				selectionRects: [rect(10, 20, 90, 120)],
				handleTolerance: 4,
			})
		).toBe('cancel');
	});

	it('容差为 0 时点恰在边界 → 旁观（边界含）', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 90, y: 120 },
				selectionRects: [rect(10, 20, 90, 120)],
				handleTolerance: 0,
			})
		).toBe('standby');
	});

	it('多行选区：点落在第二行矩形内 → 旁观', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 30, y: 300 },
				selectionRects: [
					rect(10, 20, 200, 50),
					rect(10, 80, 200, 120),
					rect(10, 260, 200, 340),
				],
				handleTolerance: 4,
			})
		).toBe('standby');
	});

	it('选区矩形集为空但有坐标 → 取消（无物可保护）', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 10, y: 10 },
				selectionRects: [],
				handleTolerance: 4,
			})
		).toBe('cancel');
	});

	it('负容差按 0 处理：越出边界即取消', () => {
		expect(
			decideSelectionPointerGuard({
				mobile: true,
				hasNonCollapsedSelection: true,
				point: { x: 150, y: 20 },
				selectionRects: [rect(10, 20, 90, 120)],
				handleTolerance: -5,
			})
		).toBe('cancel');
	});
});

describe('collectSelectionRects (选区矩形收集，守卫接线共用助手)', () => {
	it('把 Range 客户端矩形规整为四边结构并过滤零面积', () => {
		const selection = {
			isCollapsed: false,
			rangeCount: 1,
			getRangeAt: () => ({
				getClientRects: () => [
					{ left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 },
					{ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
				],
			}),
		} as unknown as Selection;
		expect(collectSelectionRects(selection)).toEqual([{ left: 10, top: 20, right: 90, bottom: 40 }]);
	});

	it('null / 折叠 / 无 range → 空数组', () => {
		expect(collectSelectionRects(null)).toEqual([]);
		expect(
			collectSelectionRects({ isCollapsed: true, rangeCount: 0 } as unknown as Selection)
		).toEqual([]);
	});

	it('getRangeAt 抛错 → 空数组（防御）', () => {
		const selection = {
			isCollapsed: false,
			rangeCount: 1,
			getRangeAt: () => {
				throw new Error('boom');
			},
		} as unknown as Selection;
		expect(collectSelectionRects(selection)).toEqual([]);
	});
});
