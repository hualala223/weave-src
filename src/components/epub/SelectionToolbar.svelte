<script lang="ts">
	import { setIcon, Platform, Menu } from 'obsidian';
	import type { App } from 'obsidian';
	import { onMount, tick, untrack } from 'svelte';
	import { tr } from '../../utils/i18n';
	import { logger } from '../../utils/logger';
	import type {
		EpubBook,
		EpubHighlightStyle,
		EpubReaderEngine,
		ReaderAnchorPoint,
		ReaderFrame,
		ReaderViewportRect,
	} from '../../services/epub';
	import { domInstanceOf } from '../../utils/dom-instance-of';
	import {
		computeToolbarPosition,
		createEventBinder,
		getEventTargetNode,
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
		canvasMode?: boolean;
		boundsEl?: HTMLElement | null;
		mobileDockBottomOffset?: number;
		externalSelection?: ExternalSelectionState | null;
		onInsertToNote?: (text: string, cfiRange: string, color?: string, style?: EpubHighlightStyle) => void;
	}

	let {
		app,
		readerService,
		book,
		readerVersion = 0,
		autoInsert = false,
		canvasMode = false,
		boundsEl = null,
		mobileDockBottomOffset = 0,
		externalSelection = null,
		onInsertToNote
	}: Props = $props();
	let t = $derived($tr);

	let toolbarEl: HTMLDivElement | undefined = $state(undefined);
	let isVisible = $state(false);
	let posTop = $state(0);
	let posLeft = $state(0);
	let isBelowSelection = $state(false);
	let toolbarMode = $state<'floating' | 'docked'>('floating');
	let arrowOffset = $state(0);
	let selectedText = $state('');
	let currentCfiRange = $state('');
	let iframeDoc: Document | null = null;
	let teardownReaderTracking: (() => void) | null = null;
	let teardownPositionTracking: (() => void) | null = null;
	let activeFrame: ReaderFrame | null = null;
	let pendingSyncFrame: number | null = null;
	let activeClearSelection: (() => void) | null = null;
	let pendingExternalSelectionHideFrame: number | null = null;
	let activeToolbarMenu: Menu | null = null;

	const isMobileToolbar = Platform.isMobile || activeDocument.body.classList.contains('is-mobile');

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
		try {
			readerService.addHighlight({ cfiRange: currentCfiRange, color, style, text: selectedText });
		} catch (e) { logger.warn('[SelectionToolbar] Failed to apply highlight:', e); }
		onInsertToNote?.(selectedText, currentCfiRange, color, style);
		clearAndHide();
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
		if (isVisible) {
			clearAndHide();
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
		} catch (e) {
			logger.warn('[SelectionToolbar] Failed to sync selection:', e);
			if (!repositionOnly) {
				hideToolbar();
			}
		}
	}

	$effect(() => {
		const currentReaderService = readerService;

		// Keep teardown handles out of the effect dependency graph to avoid
		// self-triggered reruns when the toolbar updates its own subscriptions.
		untrack(() => {
			teardownReaderTracking?.();
			teardownReaderTracking = () => {
				stopPositionTracking();
			};
		});

		const offSelection = currentReaderService.onSelectionChange(({ cfiRange, frame }) => {
			void syncSelection(frame, cfiRange);
		});
		const offHighlightClick = currentReaderService.onHighlightClick(() => {
			hideToolbar();
		});

		untrack(() => {
			teardownReaderTracking = () => {
				offSelection();
				offHighlightClick();
				stopPositionTracking();
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

	onMount(() => {
		activeDocument.addEventListener('mousedown', handlePointerDownOutside, { capture: true });
		activeDocument.addEventListener('touchstart', handlePointerDownOutside, { capture: true, passive: true });
		return () => {
			activeDocument.removeEventListener('mousedown', handlePointerDownOutside, { capture: true });
			activeDocument.removeEventListener('touchstart', handlePointerDownOutside, { capture: true });
			teardownReaderTracking?.();
			teardownReaderTracking = null;
			stopPositionTracking();
			clearPendingSync();
			clearPendingExternalSelectionHide();
		};
	});
</script>

<div
	class="epub-selection-toolbar epub-glass-panel"
	class:visible={isVisible}
	class:below-selection={isBelowSelection}
	class:mobile-docked={toolbarMode === 'docked'}
	style={`top: ${posTop}px; left: ${posLeft}px; --toolbar-arrow-offset: ${arrowOffset}px; --toolbar-bottom-offset: ${Math.max(0, mobileDockBottomOffset)}px;`}
	bind:this={toolbarEl}
>
	<div class="selection-main-row">
		<div class="selection-top-row">
			<div class="toolbar-row colors-row selection-color-row selection-primary-row">
				<button class="color-btn yellow" onclick={() => handleHighlight('yellow')}><span class="color-btn-core"></span></button>
				<button class="color-btn blue" onclick={() => handleHighlight('blue')}><span class="color-btn-core"></span></button>
				<button class="color-btn red" onclick={() => handleHighlight('red')}><span class="color-btn-core"></span></button>
				<button class="color-btn purple" onclick={() => handleHighlight('purple')}><span class="color-btn-core"></span></button>
				<button class="color-btn green" onclick={() => handleHighlight('green')}><span class="color-btn-core"></span></button>
			</div>
			<div class="selection-style-shell">
				<div class="toolbar-row selection-style-row">
					<button class="clickable-icon action-item icon-only style-action-item" onclick={() => handleHighlight('yellow', 'underline')} title="下划线"><span class="action-icon style-icon underline-style-icon" use:icon={'underline'}></span></button>
					<button class="clickable-icon action-item icon-only style-action-item" onclick={() => handleHighlight('yellow', 'strikethrough')} title="删除线"><span class="action-icon style-icon strikethrough-style-icon" use:icon={'strikethrough'}></span></button>
					<button class="clickable-icon action-item icon-only style-action-item" onclick={() => handleHighlight('yellow', 'wavy')} title="波浪线"><span class="action-icon style-icon wavy-style-icon" use:icon={'pen-tool'}></span></button>
				</div>
		</div>
		</div>
	</div>
	<div class="selection-actions-shell">
		<div class="toolbar-row actions-row selection-actions-row">
		</div>
	</div>
	<div class="toolbar-arrow"></div>
</div>
