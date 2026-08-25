<script lang="ts">
	/**
	 * ImageExtractActionBar - 书内图片提取操作条。
	 *
	 * 点图后浮出，含「提取到笔记」动作。定位与 SelectionToolbar 同源：
	 * 以宿主坐标的图片矩形为锚，换算到 .epub-reader-viewport 容器坐标，
	 * 复用 computeToolbarPosition 做翻转/边缘约束；iOS 捏合缩放下做视觉视口校正。
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { Platform, setIcon } from 'obsidian';
	import { computeToolbarPosition } from './toolbar-positioning';
	import type { ReaderImageTapInfo } from '../../services/epub/reader-engine-types';

	interface Props {
		info: ReaderImageTapInfo | null;
		boundsEl?: HTMLElement | null;
		extracting?: boolean;
		onExtract?: () => void;
		onDismiss?: () => void;
	}

	let {
		info,
		boundsEl = null,
		extracting = false,
		onExtract,
		onDismiss,
	}: Props = $props();

	let barEl: HTMLDivElement | undefined = $state(undefined);
	let posTop = $state(0);
	let posLeft = $state(0);

	const isMobileToolbar = Platform.isMobile || activeDocument.body.classList.contains('is-mobile');

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				node.replaceChildren();
				setIcon(node, newName);
			}
		};
	}

	async function positionBar() {
		const current = untrack(() => info);
		if (!current || !barEl) {
			return;
		}
		await tick();
		if (untrack(() => info) !== current || !barEl) {
			return;
		}

		const containerEl =
			boundsEl || (activeDocument.querySelector('.epub-reader-viewport') as HTMLElement | null);
		if (!containerEl) {
			return;
		}

		const containerRect = containerEl.getBoundingClientRect();
		const visualViewport = window.visualViewport;
		const zoomScale = visualViewport?.scale ?? 1;
		const zoomCorrection = isMobileToolbar && Platform.isIosApp && zoomScale > 1.001 ? zoomScale : 1;
		const toRelativeRect = (rect: ReaderImageTapInfo['rect']) => ({
			top: (rect.top - containerRect.top) / zoomCorrection,
			left: (rect.left - containerRect.left) / zoomCorrection,
			bottom: (rect.bottom - containerRect.top) / zoomCorrection,
			right: (rect.right - containerRect.left) / zoomCorrection,
			width: rect.width / zoomCorrection,
			height: rect.height / zoomCorrection,
		});

		const position = computeToolbarPosition({
			anchorRect: toRelativeRect(current.rect),
			containerWidth: containerEl.clientWidth,
			containerHeight: containerEl.clientHeight,
			toolbarWidth: barEl.offsetWidth || 180,
			toolbarHeight: barEl.offsetHeight || 44,
			mobile: isMobileToolbar,
		});
		posTop = position.top;
		posLeft = position.left;
	}

	function handlePointerDownOutside(event: Event) {
		if (!untrack(() => info) || !barEl) {
			return;
		}
		const target = event.target as Node | null;
		if (target && barEl.contains(target)) {
			return;
		}
		untrack(() => onDismiss?.());
	}

	$effect(() => {
		const currentInfo = info;
		const currentBar = barEl;
		const isExtracting = extracting;
		void currentInfo;
		void currentBar;
		void isExtracting;
		untrack(() => void positionBar());
	});

	onMount(() => {
		activeDocument.addEventListener('pointerdown', handlePointerDownOutside, true);
		activeDocument.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			untrack(() => onDismiss?.());
		});
		window.addEventListener('resize', () => untrack(() => void positionBar()));
		return () => {
			activeDocument.removeEventListener('pointerdown', handlePointerDownOutside, true);
			window.removeEventListener('resize', () => untrack(() => void positionBar()));
		};
	});
</script>

{#if info}
	<div
		class="epub-image-extract-bar epub-glass-panel"
		bind:this={barEl}
		style={`top: ${posTop}px; left: ${posLeft}px;`}
		role="menu"
	>
		<div class="epub-image-extract-actions">
			<button class="clickable-icon action-item image-extract-action" onclick={onExtract} disabled={extracting} title={'提取到笔记'}>
				<span class="action-icon" use:icon={'image-down'}></span>
				<span class="action-label">{extracting ? '提取中…' : '提取到笔记'}</span>
			</button>
		</div>
	</div>
{/if}

<style>
	.epub-image-extract-bar {
		position: absolute;
		z-index: var(--weave-z-toolbar, 900);
		display: flex;
		align-items: center;
		border-radius: 10px;
		padding: 4px 6px;
		box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
	}
	.epub-image-extract-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.image-extract-action {
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.image-extract-action:disabled {
		opacity: 0.6;
	}
</style>