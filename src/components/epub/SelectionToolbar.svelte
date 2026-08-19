<script lang="ts">
	import { setIcon, Platform, Menu } from 'obsidian';
	import type { App } from 'obsidian';
	import { onMount, tick, untrack } from 'svelte';
	import { logger } from '../../utils/logger';
	import type {
		EpubBook,
		EpubHighlightStyle,
		EpubReaderEngine,
		HighlightClickInfo,
	} from '../../services/epub';
	import type { ReaderAnchorPoint, ReaderFrame, ReaderViewportRect } from '../../services/epub/reader-engine-types';
	import { domInstanceOf } from '../../utils/dom-instance-of';
	import {
		computeToolbarPosition,
		createEventBinder,
		getEventTargetNode,
		isEventOutsideToolbar,
		shouldDismissToolbarOnPointerDown,
		resolveMobileFloatingInsetBottom,
	} from './toolbar-positioning';

	type ExternalSelectionState = {
		text: string;
		cfiRange: string;
		rect: DOMRect;
		rects?: DOMRect[];
		clear?: () => void;
	};

	interface Props {
		app: App;
		readerService: EpubReaderEngine;
		book: EpubBook | null;
		readerVersion?: number;
		autoInsert?: boolean;
		boundsEl?: HTMLElement | null;
		mobileDockBottomOffset?: number;
		externalSelection?: ExternalSelectionState | null;
		onInsertToNote?: (text: string, cfiRange: string, color?: string, style?: EpubHighlightStyle) => void;
		/** 编辑状态：点击既有标注时由宿主传入。 */
		highlightInfo?: HighlightClickInfo | null;
		deleting?: boolean;
		onDelete?: (info: HighlightClickInfo) => void;
		onTemporarilyReveal?: (info: HighlightClickInfo) => void;
		onChangeColor?: (info: HighlightClickInfo, newColor: string) => void;
		onChangeStyle?: (info: HighlightClickInfo, newStyle?: EpubHighlightStyle) => void;
		onEditComment?: (info: HighlightClickInfo) => void;
		onCopyText?: (info: HighlightClickInfo) => void;
		onDismiss?: () => void;
		/** 创建状态：「想法」默认下划线后在宿主侧持久化并打开想法输入框。 */
		onCommentCreate?: (text: string, cfiRange: string, color: string) => void;
		/** 创建状态：溯源复制 [[溯源路径|选中内容]]。 */
		onCopyTraceLink?: (text: string, cfiRange: string) => void;
		/** 调起 AI 面板（创建/编辑状态通用）。 */
		onOpenAI?: (text: string, cfiRange: string) => void;
	}

	let {
		app,
		readerService,
		book,
		readerVersion = 0,
		autoInsert = false,
		boundsEl = null,
		mobileDockBottomOffset = 0,
		externalSelection = null,
		onInsertToNote,
		highlightInfo = null,
		deleting = false,
		onDelete,
		onTemporarilyReveal,
		onChangeColor,
		onChangeStyle,
		onEditComment,
		onCopyText,
		onDismiss,
		onCommentCreate,
		onCopyTraceLink,
		onOpenAI,
	}: Props = $props();
	let toolbarEl: HTMLDivElement | undefined = $state(undefined);
	let actionsShellEl: HTMLDivElement | undefined = $state(undefined);
	let moreBtnEl: HTMLButtonElement | undefined = $state(undefined);
	let isVisible = $state(false);
	let editActive = $state(false);
	let posTop = $state(0);
	let posLeft = $state(0);
	let isBelowSelection = $state(false);
	let toolbarMode = $state<'floating' | 'docked'>('floating');
	let arrowOffset = $state(0);
	let selectedText = $state('');
	let currentCfiRange = $state('');
	let lastUsedColor = $state('yellow');
	let actionsOverflow = $state(false);
	// 隐匿文本展示（conceal）在类型层面并未建模为单独值（ReaderHighlightPresentation 只有 "highlight"），
	// 运行时由旧数据携带，这里以宽松比较识别。
	const isConcealMode = $derived(
		highlightInfo !== null && (highlightInfo.presentation as string | undefined) === 'conceal'
	);
	let iframeDoc: Document | null = null;
	let teardownReaderTracking: (() => void) | null = null;
	let teardownPositionTracking: (() => void) | null = null;
	let teardownEditTracking: (() => void) | null = null;
	let activeFrame: ReaderFrame | null = null;
	let pendingSyncFrame: number | null = null;
	let activeClearSelection: (() => void) | null = null;
	let pendingExternalSelectionHideFrame: number | null = null;
	let activeToolbarMenu: Menu | null = null;

	const isMobileToolbar = Platform.isMobile || activeDocument.body.classList.contains('is-mobile');

	const colors = ['yellow', 'blue', 'red', 'purple', 'green'] as const;
	const colorLabels: Record<(typeof colors)[number], string> = {
		yellow: '黄色',
		blue: '蓝色',
		red: '红色',
		purple: '紫色',
		green: '绿色',
	};

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				// /skip innerHTML is used to clear the trusted icon container before setIcon rerenders it
				node.replaceChildren();
				setIcon(node, newName);
			}
		};
	}

	function getFrameElement(frame: ReaderFrame | null | undefined): HTMLIFrameElement | null {
		const iframeWindow = frame?.window || frame?.frameDocument?.defaultView;
		return (iframeWindow?.frameElement as HTMLIFrameElement | null) || null;
	}

	function closestAcrossShadowHosts(node: Node | null | undefined, selector: string): HTMLElement | null {
		let current: Node | null | undefined = node;
		while (current) {
			if (domInstanceOf(current, HTMLElement)) {
				const matched = current.closest(selector) as HTMLElement | null;
				if (matched) {
					return matched;
				}
			}
			const rootNode = current.getRootNode?.();
			if (!domInstanceOf(rootNode, ShadowRoot) || !domInstanceOf(rootNode.host, HTMLElement)) {
				break;
			}
			current = rootNode.host;
		}
		return null;
	}

	function getViewportContainer(frame: ReaderFrame | null | undefined): HTMLElement | null {
		const iframe = getFrameElement(frame);
		return closestAcrossShadowHosts(iframe, '.epub-reader-viewport')
			|| boundsEl
			|| (activeDocument.querySelector('.epub-reader-viewport') as HTMLElement | null);
	}

	function getScrollTrackingHost(frame: ReaderFrame | null | undefined): HTMLElement | null {
		const iframe = getFrameElement(frame);
		return closestAcrossShadowHosts(iframe, '.epub-content-wrapper')
			|| (activeDocument.querySelector('.epub-content-wrapper') as HTMLElement | null);
	}

	function viewportRectToDOMRect(rect: ReaderViewportRect): DOMRect {
		return new DOMRect(rect.left, rect.top, rect.width, rect.height);
	}

	function resolveSelectionGeometry(
		cfiRange: string,
		frame: ReaderFrame,
		selection: Selection
	): {
		rect: DOMRect;
		rects: DOMRect[];
		anchorPoint?: ReaderAnchorPoint;
	} | null {
		const geometry = readerService.getSelectionViewportGeometry?.(cfiRange);
		if (geometry?.rect) {
			const rects = (geometry.rects?.length ? geometry.rects : [geometry.rect]).map(viewportRectToDOMRect);
			return {
				rect: viewportRectToDOMRect(geometry.rect),
				rects,
				anchorPoint: geometry.anchorPoint,
			};
		}

		const rangeRect = getSelectionRect(selection);
		const rangeRects = getSelectionRects(selection);
		const iframe = getFrameElement(frame);
		if (rangeRect && iframe) {
			const iframeRect = iframe.getBoundingClientRect();
			return {
				rect: new DOMRect(
					rangeRect.left + iframeRect.left,
					rangeRect.top + iframeRect.top,
					rangeRect.width,
					rangeRect.height
				),
				rects: rangeRects.map(
					(rect) =>
						new DOMRect(
							rect.left + iframeRect.left,
							rect.top + iframeRect.top,
							rect.width,
							rect.height
						)
				),
			};
		}
		if (rangeRect) {
			return {
				rect: rangeRect,
				rects: rangeRects,
			};
		}

		const navigationRect = readerService.getNavigationTargetRect({
			cfi: cfiRange,
			text: selection.toString().trim(),
		});
		if (!navigationRect) {
			return null;
		}
		return {
			rect: navigationRect,
			rects: [navigationRect],
		};
	}

	function clearPendingSync() {
		if (pendingSyncFrame !== null) {
			window.cancelAnimationFrame(pendingSyncFrame);
			pendingSyncFrame = null;
		}
	}

	function clearPendingExternalSelectionHide() {
		if (pendingExternalSelectionHideFrame !== null) {
			window.cancelAnimationFrame(pendingExternalSelectionHideFrame);
			pendingExternalSelectionHideFrame = null;
		}
	}

	function stopPositionTracking() {
		clearPendingSync();
		teardownPositionTracking?.();
		teardownPositionTracking = null;
		activeFrame = null;
	}

	function stopEditTracking() {
		teardownEditTracking?.();
		teardownEditTracking = null;
	}

	function dismissActiveToolbarMenu(): void {
		if (!activeToolbarMenu) {
			return;
		}
		activeToolbarMenu.hide();
		if (typeof activeToolbarMenu.close === 'function') {
			activeToolbarMenu.close();
		}
		activeToolbarMenu = null;
	}

	function hideToolbar() {
		dismissActiveToolbarMenu();
		clearPendingExternalSelectionHide();
		isVisible = false;
		isBelowSelection = false;
		toolbarMode = 'floating';
		arrowOffset = 0;
		selectedText = '';
		currentCfiRange = '';
		activeClearSelection = null;
		stopPositionTracking();
	}

	function clearAndHide() {
		if (activeClearSelection) {
			activeClearSelection();
		} else if (iframeDoc) {
			iframeDoc.getSelection()?.removeAllRanges();
		}
		hideToolbar();
	}

	async function handleHighlight(color: string, style?: EpubHighlightStyle) {
		if (!book || !selectedText || !currentCfiRange) { clearAndHide(); return; }
		lastUsedColor = color;
		try {
			readerService.addHighlight({ cfiRange: currentCfiRange, color, style, text: selectedText });
		} catch (e) { logger.warn('[SelectionToolbar] Failed to apply highlight:', e); }
		onInsertToNote?.(selectedText, currentCfiRange, color, style);
		clearAndHide();
	}

	function hasNonCollapsedIframeSelection(): boolean {
		const selection = iframeDoc?.getSelection?.();
		return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
	}

	function handlePointerDownOutside(event: Event) {
		if (!shouldDismissToolbarOnPointerDown(toolbarEl, event)) {
			const target = getEventTargetNode(event.target);
			if (target && toolbarEl?.contains(target)) {
				dismissActiveToolbarMenu();
			}
			return;
		}

		dismissActiveToolbarMenu();
		// 移动端原生选择 handle 的拖拽会以 touchstart 落到 iframe；此时清空选区会打断扩选。
		// 扩选期间保持旁观，待浏览器自行收起选区后由 selectionchange 统一隐藏工具条。
		if (isMobileToolbar && event.type === 'touchstart' && hasNonCollapsedIframeSelection()) {
			return;
		}
		if (editActive) {
			untrack(() => onDismiss?.());
		}
		if (isVisible) {
			clearAndHide();
		}
	}

	function handleEditClickOutside(event: Event) {
		if (untrack(() => Boolean(highlightInfo)) && isEventOutsideToolbar(toolbarEl, event)) {
			untrack(() => onDismiss?.());
		}
	}

	function getSelectionRect(selection: Selection): DOMRect | null {
		if (!selection.rangeCount) return null;
		const range = selection.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		if (rect.width || rect.height) {
			return rect;
		}

		const rects = range.getClientRects();
		if (!rects.length) return null;

		let left = rects[0].left;
		let top = rects[0].top;
		let right = rects[0].right;
		let bottom = rects[0].bottom;

		for (let i = 1; i < rects.length; i++) {
			const current = rects[i];
			left = Math.min(left, current.left);
			top = Math.min(top, current.top);
			right = Math.max(right, current.right);
			bottom = Math.max(bottom, current.bottom);
		}

		return new DOMRect(left, top, right - left, bottom - top);
	}

	function getSelectionRects(selection: Selection): DOMRect[] {
		if (!selection.rangeCount) return [];
		const range = selection.getRangeAt(0);
		const rects = Array.from(range.getClientRects());
		if (rects.length) {
			return rects.map((rect) => new DOMRect(rect.left, rect.top, rect.width, rect.height));
		}
		const rect = range.getBoundingClientRect();
		return rect.width || rect.height ? [new DOMRect(rect.left, rect.top, rect.width, rect.height)] : [];
	}

	function measureActionsOverflow() {
		const el = actionsShellEl;
		if (!el) {
			actionsOverflow = false;
			return;
		}
		actionsOverflow = el.scrollWidth - el.clientWidth > 1;
	}

	async function positionToolbar(
		anchorRect: DOMRect,
		containerEl: HTMLElement,
		anchorRects: DOMRect[] = [],
		anchorPoint?: ReaderAnchorPoint
	) {
		isVisible = true;
		await tick();

		if (!toolbarEl) return;

		const containerRect = containerEl.getBoundingClientRect();

		// iOS（WKWebView/Safari）捏合缩放时，getBoundingClientRect 返回的是视觉视口坐标系；
		// 而工具栏按布局坐标系做 absolute 定位。把差值折算回布局坐标，避免工具栏偏离选中文字。
		const visualViewport = window.visualViewport;
		const zoomScale = visualViewport?.scale ?? 1;
		const zoomCorrection = isMobileToolbar && Platform.isIosApp && zoomScale > 1.001 ? zoomScale : 1;
		const toRelativeRect = (rect: DOMRect) => ({
			top: (rect.top - containerRect.top) / zoomCorrection,
			left: (rect.left - containerRect.left) / zoomCorrection,
			bottom: (rect.bottom - containerRect.top) / zoomCorrection,
			right: (rect.right - containerRect.left) / zoomCorrection,
			width: rect.width / zoomCorrection,
			height: rect.height / zoomCorrection,
		});

		const position = computeToolbarPosition({
			anchorRect: toRelativeRect(anchorRect),
			anchorRects: anchorRects.map((rect) => toRelativeRect(rect)),
			anchorPoint: anchorPoint
				? {
					x: (anchorPoint.x - containerRect.left) / zoomCorrection,
					y: (anchorPoint.y - containerRect.top) / zoomCorrection,
				}
				: undefined,
			containerWidth: containerEl.clientWidth,
			containerHeight: containerEl.clientHeight,
			toolbarWidth: toolbarEl.offsetWidth || 296,
			toolbarHeight: toolbarEl.offsetHeight || 78,
			mobile: isMobileToolbar,
			insetBottom: isMobileToolbar
				? resolveMobileFloatingInsetBottom(mobileDockBottomOffset)
				: 0,
		});

		toolbarMode = position.mode;
		posTop = position.top;
		posLeft = position.left;
		isBelowSelection = position.isBelowAnchor;
		arrowOffset = position.arrowOffset;
		measureActionsOverflow();
	}

	function scheduleActiveSync() {
		if (!activeFrame) return;
		const frame = activeFrame;
		const trackedCfiRange = currentCfiRange;
		clearPendingSync();
		pendingSyncFrame = window.requestAnimationFrame(() => {
			pendingSyncFrame = null;
			void syncSelection(frame, trackedCfiRange || undefined);
		});
	}

	function startPositionTracking(frame: ReaderFrame) {
		if (activeFrame === frame && teardownPositionTracking) {
			return;
		}

		stopPositionTracking();
		activeFrame = frame;

		const iframeWindow = frame.window || frame.frameDocument?.defaultView;
		const iframeDocument = iframeWindow?.document;
		const scrollHost = getScrollTrackingHost(frame);
		const visualViewport = window.visualViewport;
		const binder = createEventBinder();

		binder.bind(scrollHost, 'scroll', scheduleActiveSync, { passive: true });
		binder.bind(iframeWindow, 'scroll', scheduleActiveSync, { passive: true });
		binder.bind(iframeWindow, 'resize', scheduleActiveSync);
		binder.bind(iframeDocument, 'selectionchange', scheduleActiveSync);
		binder.bind(iframeDocument, 'mousedown', handlePointerDownOutside, { capture: true });
		binder.bind(iframeDocument, 'touchstart', handlePointerDownOutside, { capture: true, passive: true });
		binder.bind(activeDocument, 'mousedown', handlePointerDownOutside, { capture: true });
		binder.bind(activeDocument, 'touchstart', handlePointerDownOutside, { capture: true, passive: true });
		binder.bind(window, 'resize', scheduleActiveSync);
		binder.bind(window, 'orientationchange', scheduleActiveSync);
		binder.bind(visualViewport, 'resize', scheduleActiveSync);
		binder.bind(visualViewport, 'scroll', scheduleActiveSync);

		teardownPositionTracking = () => {
			binder.dispose();
		};
	}

	async function syncSelection(frame: ReaderFrame, cfiRange?: string) {
		const repositionOnly = isVisible && Boolean(cfiRange);
		try {
			// 编辑状态优先：切换新选区需要先让宿主清掉编辑态。
			if (untrack(() => Boolean(highlightInfo))) {
				untrack(() => onDismiss?.());
				return;
			}

			const iframeWindow = frame.window || frame.frameDocument?.defaultView;
			if (!iframeWindow) {
				if (!repositionOnly) {
					hideToolbar();
				}
				return;
			}

			iframeDoc = iframeWindow.document;
			const selection = iframeWindow.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				hideToolbar();
				return;
			}

			const text = selection.toString().trim();
			if (!text) {
				if (!repositionOnly) {
					hideToolbar();
				}
				return;
			}

			const range = selection.getRangeAt(0);
			const resolvedCfiRange = cfiRange || frame.cfiFromRange(range);
			if (!resolvedCfiRange) {
				if (!repositionOnly) {
					hideToolbar();
				}
				return;
			}

			const viewportEl = getViewportContainer(frame);
			if (!viewportEl) {
				if (!repositionOnly) {
					hideToolbar();
				}
				return;
			}

			selectedText = text;
			currentCfiRange = resolvedCfiRange;
			activeClearSelection = null;

			const geometry = resolveSelectionGeometry(resolvedCfiRange, frame, selection);
			if (!geometry) {
				if (!repositionOnly) {
					hideToolbar();
				}
				return;
			}

			startPositionTracking(frame);
			await positionToolbar(geometry.rect, viewportEl, geometry.rects, geometry.anchorPoint);
			measureActionsOverflow();
		} catch (e) {
			logger.warn('[SelectionToolbar] Failed to sync selection:', e);
			if (!repositionOnly) {
				hideToolbar();
			}
		}
	}

	async function positionForHighlight(info: HighlightClickInfo) {
		stopEditTracking();
		editActive = true;
		await tick();

		if (!toolbarEl || untrack(() => highlightInfo) !== info) {
			return;
		}

		startEditTracking();

		const viewportEl = toolbarEl.closest('.epub-reader-viewport') as HTMLElement | null
			|| (activeDocument.querySelector('.epub-reader-viewport') as HTMLElement | null);
		if (!viewportEl) {
			return;
		}

		const containerRect = viewportEl.getBoundingClientRect();
		const toRelativeRect = (rect: HighlightClickInfo['rect']) => ({
			top: (rect.top - containerRect.top),
			left: (rect.left - containerRect.left),
			bottom: (rect.bottom - containerRect.top),
			right: (rect.right - containerRect.left),
			width: rect.width,
			height: rect.height,
		});

		const position = computeToolbarPosition({
			anchorRect: toRelativeRect(info.rect),
			anchorRects: (info.rects || []).map((rect) => toRelativeRect(rect)),
			anchorPoint: info.anchorPoint
				? {
					x: info.anchorPoint.x - containerRect.left,
					y: info.anchorPoint.y - containerRect.top,
				}
				: undefined,
			containerWidth: viewportEl.clientWidth,
			containerHeight: viewportEl.clientHeight,
			toolbarWidth: toolbarEl.offsetWidth || 296,
			toolbarHeight: toolbarEl.offsetHeight || 78,
			mobile: isMobileToolbar,
			insetBottom: isMobileToolbar
				? resolveMobileFloatingInsetBottom(mobileDockBottomOffset)
				: 0,
		});

		toolbarMode = position.mode;
		posTop = position.top;
		posLeft = position.left;
		isBelowSelection = position.isBelowAnchor;
		arrowOffset = position.arrowOffset;
		measureActionsOverflow();
	}

	function startEditTracking() {
		stopEditTracking();
		const binder = createEventBinder();
		const visualViewport = window.visualViewport;
		const dismiss = () => onDismiss?.();

		const viewportEl = toolbarEl?.closest('.epub-reader-viewport') as HTMLElement | null;
		const scrollHost = viewportEl?.querySelector('.epub-content-wrapper') as HTMLElement | null;

		binder.bind(scrollHost, 'scroll', dismiss, { passive: true });
		binder.bind(viewportEl, 'scroll', dismiss, { passive: true });
		binder.bind(window, 'resize', () => {
			dismiss();
			measureActionsOverflow();
		});
		binder.bind(window, 'orientationchange', dismiss);
		binder.bind(visualViewport, 'resize', dismiss);
		binder.bind(visualViewport, 'scroll', dismiss);

		for (const frame of readerService.getVisibleFrames()) {
			if (frame?.frameDocument) {
				binder.bind(frame.frameDocument, 'mousedown', handleEditClickOutside, { capture: true });
				binder.bind(frame.frameDocument, 'touchstart', handleEditClickOutside, { capture: true, passive: true });
			}
		}
		binder.bind(activeDocument, 'mousedown', handlePointerDownOutside, { capture: true });
		binder.bind(activeDocument, 'touchstart', handlePointerDownOutside, { capture: true, passive: true });

		teardownEditTracking = () => {
			binder.dispose();
		};
	}

	function handleCommentCreateAction() {
		if (!book || !selectedText || !currentCfiRange) {
			clearAndHide();
			return;
		}
		onCommentCreate?.(selectedText, currentCfiRange, lastUsedColor || 'yellow');
		clearAndHide();
	}

	function handleOpenAction(text: string, cfiRange: string) {
		onOpenAI?.(text, cfiRange);
		if (!untrack(() => Boolean(highlightInfo))) {
			clearAndHide();
		}
	}

	function openMoreMenu(event: MouseEvent) {
		dismissActiveToolbarMenu();
		const currentInfo = untrack(() => highlightInfo);
		const editNow = Boolean(currentInfo);
		const actionText = editNow ? currentInfo?.text || '' : selectedText;
		const actionCfi = editNow ? currentInfo?.cfiRange || '' : currentCfiRange;

		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle('复制');
			item.setIcon('clipboard-copy');
			item.onClick(() => {
				if (editNow && currentInfo) {
					onCopyText?.(currentInfo);
				} else {
					onCopyTraceLink?.(actionText, actionCfi);
				}
			});
		});
		menu.addItem((item) => {
			item.setTitle('AI');
			item.setIcon('bot');
			item.onClick(() => handleOpenAction(actionText, actionCfi));
		});
		activeToolbarMenu = menu;
		if (moreBtnEl) {
			const rect = moreBtnEl.getBoundingClientRect();
			menu.showAtPosition({ x: rect.right, y: rect.top });
		} else {
			menu.showAtMouseEvent(event);
		}
	}

	$effect(() => {
		const currentReaderService = readerService;

		untrack(() => {
			teardownReaderTracking?.();
			teardownReaderTracking = () => {
				stopPositionTracking();
				stopEditTracking();
			};
		});

		const offSelection = currentReaderService.onSelectionChange(({ cfiRange, frame }) => {
			void syncSelection(frame, cfiRange);
		});
		const offHighlightClick = currentReaderService.onHighlightClick(() => {
			if (!untrack(() => Boolean(highlightInfo))) {
				hideToolbar();
			}
		});

		untrack(() => {
			teardownReaderTracking = () => {
				offSelection();
				offHighlightClick();
				stopPositionTracking();
				stopEditTracking();
			};
		});

		return () => {
			untrack(() => {
				teardownReaderTracking?.();
				teardownReaderTracking = null;
			});
		};
	});

	$effect(() => {
		const _readerVersion = readerVersion;
		untrack(() => {
			hideToolbar();
			onDismiss?.();
		});
	});

	$effect(() => {
		const selection = externalSelection;
		if (!selection) {
			const hasActiveClearSelection = untrack(() => Boolean(activeClearSelection));
			if (hasActiveClearSelection) {
				clearPendingExternalSelectionHide();
				pendingExternalSelectionHideFrame = window.requestAnimationFrame(() => {
					pendingExternalSelectionHideFrame = null;
					if (!externalSelection) {
						hideToolbar();
					}
				});
			}
			return;
		}
		clearPendingExternalSelectionHide();

		const viewportEl = boundsEl || (activeDocument.querySelector('.epub-reader-viewport') as HTMLElement | null);
		if (!viewportEl) {
			untrack(() => {
				hideToolbar();
			});
			return;
		}

		untrack(() => {
			selectedText = selection.text;
			currentCfiRange = selection.cfiRange;
			activeClearSelection = selection.clear || null;
			stopPositionTracking();
		});
		void positionToolbar(selection.rect, viewportEl, selection.rects || [selection.rect]);
	});

	$effect(() => {
		const info = highlightInfo;
		if (!info) {
			untrack(() => {
				editActive = false;
				stopEditTracking();
				stopPositionTracking();
			});
			return;
		}
		untrack(() => {
			stopPositionTracking();
		});
		void positionForHighlight(info);
	});

	onMount(() => {
		activeDocument.addEventListener('mousedown', handlePointerDownOutside, { capture: true });
		activeDocument.addEventListener('touchstart', handlePointerDownOutside, { capture: true, passive: true });
		window.addEventListener('resize', measureActionsOverflow);
		window.addEventListener('orientationchange', measureActionsOverflow);
		return () => {
			activeDocument.removeEventListener('mousedown', handlePointerDownOutside, { capture: true });
			activeDocument.removeEventListener('touchstart', handlePointerDownOutside, { capture: true });
			window.removeEventListener('resize', measureActionsOverflow);
			window.removeEventListener('orientationchange', measureActionsOverflow);
			teardownReaderTracking?.();
			teardownReaderTracking = null;
			stopPositionTracking();
			stopEditTracking();
			clearPendingSync();
			clearPendingExternalSelectionHide();
		};
	});
</script>

<div
	class="epub-selection-toolbar epub-highlight-toolbar epub-glass-panel"
	class:visible={editActive || isVisible}
	class:below-selection={isBelowSelection}
	class:mobile-docked={toolbarMode === 'docked'}
	class:is-edit={editActive}
	class:is-create={!editActive && isVisible}
	style={`top: ${posTop}px; left: ${posLeft}px; --toolbar-arrow-offset: ${arrowOffset}px; --toolbar-bottom-offset: ${Math.max(0, mobileDockBottomOffset)}px;`}
	bind:this={toolbarEl}
>
	{#if editActive && highlightInfo}
		{#if isConcealMode}
			<div class="selection-main-row">
				<div class="selection-actions-shell">
					<div class="toolbar-row actions-row selection-actions-row highlight-actions-row concealment-actions">
						<button class="clickable-icon action-item" onclick={() => onTemporarilyReveal?.(highlightInfo)} title={'暂时显示隐藏文本'}>
							<span class="action-icon" use:icon={'eye'}></span>
							<span class="action-label">{'暂显'}</span>
						</button>
						<button class="clickable-icon action-item" onclick={() => onCopyText?.(highlightInfo)} title={'复制隐藏文本'}>
							<span class="action-icon" use:icon={'clipboard-copy'}></span>
							<span class="action-label">{'复制'}</span>
						</button>
						<button class="clickable-icon action-item accent concealment-reset" onclick={() => onDelete?.(highlightInfo)} title={'恢复文本显示'}>
							<span class="action-icon" use:icon={'eye'}></span>
							<span class="action-label">{'恢复'}</span>
						</button>
					</div>
				</div>
			</div>
		{:else}
			<div class="selection-main-row">
				<div class="selection-top-row">
					<div class="selection-style-shell">
						<div class="toolbar-row selection-style-row">
							<div class="toolbar-row colors-row selection-color-row selection-primary-row">
								{#each colors as c}
									<button
										class="color-btn {c}"
										class:active={c === highlightInfo?.color}
										onclick={() => { lastUsedColor = c; onChangeColor?.(highlightInfo, c); }}
										title={`切换为${colorLabels[c]}`}
										aria-label={`切换为${colorLabels[c]}颜色`}
									>
										<span class="color-btn-core"></span>
									</button>
								{/each}
							</div>
							<span class="row-divider" aria-hidden="true"></span>
							<button class="clickable-icon action-item icon-only style-action-item" class:accent={highlightInfo?.style === 'underline'} onclick={() => onChangeStyle?.(highlightInfo, highlightInfo?.style === 'underline' ? undefined : 'underline')} title={'下划线'} aria-label={'下划线'}>
								<span class="action-icon style-icon underline-style-icon" use:icon={'underline'}></span>
							</button>
							<button class="clickable-icon action-item icon-only style-action-item" class:accent={highlightInfo?.style === 'strikethrough'} onclick={() => onChangeStyle?.(highlightInfo, highlightInfo?.style === 'strikethrough' ? undefined : 'strikethrough')} title={'删除线'} aria-label={'删除线'}>
								<span class="action-icon style-icon strikethrough-style-icon" use:icon={'strikethrough'}></span>
							</button>
							<button class="clickable-icon action-item icon-only style-action-item" class:accent={highlightInfo?.style === 'wavy'} onclick={() => onChangeStyle?.(highlightInfo, highlightInfo?.style === 'wavy' ? undefined : 'wavy')} title={'波浪线'} aria-label={'波浪线'}>
								<span class="action-icon style-icon wavy-style-icon" use:icon={'pen-tool'}></span>
							</button>
						</div>
					</div>
				</div>
				<div class="selection-actions-shell">
					<div class="toolbar-row actions-row selection-actions-row highlight-actions-row" bind:this={actionsShellEl}>
						<button class="clickable-icon action-item comment-action" class:accent={Boolean(highlightInfo.hasCommentDivider)} onclick={() => onEditComment?.(highlightInfo)} title={'编辑想法'} aria-label={'编辑想法'}>
							<span class="action-icon" use:icon={'message-square'}></span>
							<span class="action-label">{'想法'}</span>
						</button>
						{#if !actionsOverflow}
							<button class="clickable-icon action-item copy-action" onclick={() => onCopyText?.(highlightInfo)} title={'复制文本'}>
								<span class="action-icon" use:icon={'clipboard-copy'}></span>
								<span class="action-label">{'复制'}</span>
							</button>
							<button class="clickable-icon action-item ai" onclick={() => handleOpenAction(highlightInfo.text || '', highlightInfo.cfiRange || '')} title={'AI 查词 / 解释 / 翻译'}>
								<span class="action-icon" use:icon={'bot'}></span>
								<span class="action-label">{'AI'}</span>
							</button>
						{/if}
						{#if actionsOverflow}
							<button class="clickable-icon action-item icon-only" bind:this={moreBtnEl} onclick={openMoreMenu} title={'更多'}>
								<span class="action-icon" use:icon={'more-horizontal'}></span>
							</button>
						{/if}
						<span class="row-divider" aria-hidden="true"></span>
						<button class="clickable-icon action-item delete delete-action" disabled={deleting} onclick={() => onDelete?.(highlightInfo)} title={'删除高亮'}>
							<span class="action-icon" use:icon={'trash-2'}></span>
							<span class="action-label">{'删除'}</span>
						</button>
					</div>
				</div>
			</div>
		{/if}
	{:else if isVisible}
		<div class="selection-main-row">
			<div class="selection-top-row">
				<div class="selection-style-shell">
					<div class="toolbar-row selection-style-row">
						<div class="toolbar-row colors-row selection-color-row selection-primary-row">
							{#each colors as c}
								<button class="color-btn {c}" onclick={() => void handleHighlight(c)} title={colorLabels[c]} aria-label={`添加${colorLabels[c]}颜色`}>
									<span class="color-btn-core"></span>
								</button>
							{/each}
						</div>
						<span class="row-divider" aria-hidden="true"></span>
						<button class="clickable-icon action-item icon-only style-action-item" onclick={() => void handleHighlight('yellow', 'underline')} title="下划线"><span class="action-icon style-icon underline-style-icon" use:icon={'underline'}></span></button>
						<button class="clickable-icon action-item icon-only style-action-item" onclick={() => void handleHighlight('yellow', 'strikethrough')} title="删除线"><span class="action-icon style-icon strikethrough-style-icon" use:icon={'strikethrough'}></span></button>
						<button class="clickable-icon action-item icon-only style-action-item" onclick={() => void handleHighlight('yellow', 'wavy')} title="波浪线"><span class="action-icon style-icon wavy-style-icon" use:icon={'pen-tool'}></span></button>
					</div>
				</div>
			</div>
			<div class="selection-actions-shell">
				<div class="toolbar-row actions-row selection-actions-row" bind:this={actionsShellEl}>
					<button class="clickable-icon action-item comment-action" onclick={handleCommentCreateAction} title={'默认下划线并打开想法输入框'}>
						<span class="action-icon" use:icon={'message-square'}></span>
						<span class="action-label">{'想法'}</span>
					</button>
					{#if !actionsOverflow}
						<button class="clickable-icon action-item copy-action" onclick={() => onCopyTraceLink?.(selectedText, currentCfiRange)} title={'复制溯源链接'}>
							<span class="action-icon" use:icon={'clipboard-copy'}></span>
							<span class="action-label">{'复制'}</span>
						</button>
						<button class="clickable-icon action-item ai" onclick={() => handleOpenAction(selectedText, currentCfiRange)} title={'AI 查词 / 解释 / 翻译'}>
							<span class="action-icon" use:icon={'bot'}></span>
							<span class="action-label">{'AI'}</span>
						</button>
					{/if}
					{#if actionsOverflow}
						<button class="clickable-icon action-item icon-only" bind:this={moreBtnEl} onclick={openMoreMenu} title={'更多'}>
							<span class="action-icon" use:icon={'more-horizontal'}></span>
						</button>
					{/if}
				</div>
			</div>
		</div>
	{/if}
	<div class="toolbar-arrow"></div>
</div>
