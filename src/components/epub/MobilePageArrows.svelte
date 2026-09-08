<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { setIcon } from 'obsidian';
	import {
		clampArrowPosition,
		createArrowGestureController,
		getDefaultArrowPosition,
		positionFromRatio,
		positionToRatio,
		type MobileArrowDirection,
		type MobileArrowPoint,
	} from './mobile-page-arrows';
	import type { EpubPageArrowPosition } from '../../services/epub/types';

	interface Props {
		onPrev: () => void;
		onNext: () => void;
		/** 已保存的停放位置（比例）；null = 未拖过，默认左下角。 */
		position: EpubPageArrowPosition | null;
		/** 定位与 clamp 的边界容器（阅读视口）。 */
		boundsEl: HTMLElement | null;
		onPositionChange: (position: EpubPageArrowPosition) => void;
	}

	let { onPrev, onNext, position, boundsEl, onPositionChange }: Props = $props();

	let containerEl: HTMLDivElement | undefined = $state(undefined);
	let pos = $state<MobileArrowPoint>({ x: 0, y: 0 });
	let dragging = $state(false);
	let grabOffset = $state<MobileArrowPoint>({ x: 0, y: 0 });
	/** 单击判定需要记住按下落在哪个箭头上（状态机 onUp 不带事件）。 */
	let pressedDirection: MobileArrowDirection = 'prev';
	let pointerId: number | null = null;
	/** 状态机 onDragMove 不携带坐标，最新指针位置经此共享给拖动回调。 */
	let gesturePointer: MobileArrowPoint = { x: 0, y: 0 };

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

	function getViewportSize() {
		const rect = boundsEl?.getBoundingClientRect();
		return {
			width: rect?.width || window.innerWidth,
			height: rect?.height || window.innerHeight,
		};
	}

	function getArrowSize(): { width: number; height: number } {
		const rect = containerEl?.getBoundingClientRect();
		return {
			width: rect?.width || 48,
			height: rect?.height || 96,
		};
	}

	function toLocalPoint(clientX: number, clientY: number): MobileArrowPoint {
		const rect = boundsEl?.getBoundingClientRect();
		return {
			x: clientX - (rect?.left || 0),
			y: clientY - (rect?.top || 0),
		};
	}

	function syncPosition() {
		if (!containerEl) {
			return;
		}
		const viewport = getViewportSize();
		const size = getArrowSize();
		pos = position
			? positionFromRatio(position, size, viewport)
			: getDefaultArrowPosition(size, viewport);
	}

	const gesture = createArrowGestureController({
		onTap: (direction) => {
			if (direction === 'prev') {
				onPrev();
			} else {
				onNext();
			}
		},
		onDragStart: () => {
			dragging = true;
		},
		onDragMove: () => {
			const viewport = getViewportSize();
			const size = getArrowSize();
			pos = clampArrowPosition(
				{
					x: gesturePointer.x - grabOffset.x,
					y: gesturePointer.y - grabOffset.y,
				},
				size,
				viewport
			);
		},
		onDragEnd: () => {
			dragging = false;
			if (!containerEl) {
				return;
			}
			onPositionChange(positionToRatio(pos, getArrowSize(), getViewportSize()));
		},
	});

	function handlePointerDown(event: PointerEvent) {
		if (pointerId !== null) {
			return;
		}
		const target = event.target as HTMLElement | null;
		const arrowButton = target?.closest?.('[data-arrow-direction]');
		pressedDirection =
			arrowButton?.getAttribute('data-arrow-direction') === 'next' ? 'next' : 'prev';
		pointerId = event.pointerId;
		containerEl?.setPointerCapture?.(event.pointerId);
		gesturePointer = toLocalPoint(event.clientX, event.clientY);
		grabOffset = {
			x: gesturePointer.x - pos.x,
			y: gesturePointer.y - pos.y,
		};
		gesture.onDown(pressedDirection, gesturePointer);
	}

	function handlePointerMove(event: PointerEvent) {
		if (pointerId !== event.pointerId) {
			return;
		}
		gesturePointer = toLocalPoint(event.clientX, event.clientY);
		gesture.onMove(gesturePointer);
	}

	function handlePointerUp(event: PointerEvent) {
		if (pointerId !== event.pointerId) {
			return;
		}
		pointerId = null;
		containerEl?.releasePointerCapture?.(event.pointerId);
		gesture.onUp();
	}

	function handlePointerCancel(event: PointerEvent) {
		if (pointerId !== event.pointerId) {
			return;
		}
		pointerId = null;
		containerEl?.releasePointerCapture?.(event.pointerId);
		gesture.onCancel();
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
	}

	$effect(() => {
		// position / boundsEl 变化（含设置异步加载完成）时重算停放点。
		void position;
		void boundsEl;
		if (!containerEl) {
			return;
		}
		void tick().then(syncPosition);
	});

	onMount(() => {
		syncPosition();
		const observer = new ResizeObserver(() => syncPosition());
		if (boundsEl) {
			observer.observe(boundsEl);
		}
		window.addEventListener('resize', syncPosition);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', syncPosition);
			gesture.destroy();
		};
	});
</script>

<div
	class="epub-mobile-page-arrows"
	class:dragging
	bind:this={containerEl}
	style:left="{pos.x}px"
	style:top="{pos.y}px"
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
	oncontextmenu={handleContextMenu}
	role="group"
	aria-label={'翻页箭头'}
>
	<button
		type="button"
		class="epub-mobile-page-arrow"
		data-arrow-direction="prev"
		title={'上一屏'}
		aria-label={'上一屏'}
	>
		<span class="epub-mobile-page-arrow-icon" use:icon={'arrow-up'}></span>
	</button>
	<button
		type="button"
		class="epub-mobile-page-arrow"
		data-arrow-direction="next"
		title={'下一屏'}
		aria-label={'下一屏'}
	>
		<span class="epub-mobile-page-arrow-icon" use:icon={'arrow-down'}></span>
	</button>
</div>

<style>
	.epub-mobile-page-arrows {
		position: absolute;
		z-index: calc(var(--epub-z-float) + 2);
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 5px;
		border-radius: 999px;
		background: var(--epub-bg-glass, color-mix(in srgb, var(--background-primary) 86%, transparent));
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		opacity: 0.62;
		transition: opacity var(--epub-transition-fast), transform var(--epub-transition-fast);
	}

	.epub-mobile-page-arrows.dragging {
		opacity: 1;
		transform: scale(1.06);
	}

	.epub-mobile-page-arrow {
		appearance: none;
		-webkit-appearance: none;
		width: 38px;
		height: 38px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: 50%;
		background: transparent;
		box-shadow: none;
		color: var(--epub-text-muted);
		cursor: pointer;
		pointer-events: auto;
	}

	.epub-mobile-page-arrow:active {
		background: var(--background-modifier-hover);
	}

	.epub-mobile-page-arrow:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 2px;
	}

	.epub-mobile-page-arrow-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.epub-mobile-page-arrow-icon :global(.svg-icon) {
		width: 20px;
		height: 20px;
	}
</style>
