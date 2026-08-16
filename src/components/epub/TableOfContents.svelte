<script lang="ts">
	import { tick } from 'svelte';
	import { setIcon } from 'obsidian';
	import { domInstanceOf } from '../../utils/dom-instance-of';
	import type { TocItem } from '../../services/epub';
import { flattenTocItems, isTocHrefActive, type FlatTocItem } from '../../utils/epub-toc-reading-position';
	import EpubLoadingState from './EpubLoadingState.svelte';

	interface Props {
		items: TocItem[];
		loading?: boolean;
		loadFailed?: boolean;
		activeHref?: string | null;
		lastReadHref?: string | null;
		autoScrollToActive?: boolean;
		onNavigate: (href: string) => void;
	}

	let {
		items,
		loading = false,
		loadFailed = false,
		activeHref = null,
		lastReadHref = null,
		autoScrollToActive = true,
		onNavigate,
	}: Props = $props();

	let tocListEl: HTMLDivElement | undefined = $state(undefined);
	let lastAutoScrolledActiveHref = '';

	function handleClick(item: TocItem) {
		onNavigate(item.href);
	}

	function handleKeydown(event: KeyboardEvent, item: TocItem) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick(item);
		}
	}

	function isLastReadItem(item: FlatTocItem): boolean {
		return isTocHrefActive(item.href, lastReadHref);
	}

	function isActiveItem(item: FlatTocItem): boolean {
		return isTocHrefActive(item.href, activeHref);
	}

	function lastReadIcon(node: HTMLElement) {
		setIcon(node, 'map-pin');
		return {
			destroy() {
				node.replaceChildren();
			}
		};
	}

	function currentLocationIcon(node: HTMLElement) {
		setIcon(node, 'locate-fixed');
		return {
			destroy() {
				node.replaceChildren();
			}
		};
	}

	function resolveItemAriaLabel(item: FlatTocItem, isActive: boolean, isLastRead: boolean): string | undefined {
		if (isActive) {
			return `当前阅读：${item.label}`;
		}
		if (isLastRead) {
			return `上次阅读：${item.label}`;
		}
		return undefined;
	}

	let flatItems = $derived(flattenTocItems(items));

	$effect(() => {
		void items;
		lastAutoScrolledActiveHref = '';
	});

	$effect(() => {
		const href = String(activeHref || '').trim();
		const itemCount = flatItems.length;
		if (!autoScrollToActive || !href || !tocListEl || itemCount === 0) {
			return;
		}
		if (href === lastAutoScrolledActiveHref) {
			return;
		}
		void tick().then(() => {
			const activeEl = tocListEl?.querySelector('.epub-toc-item.active');
			const found = domInstanceOf(activeEl, HTMLElement);
			if (found) {
				activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				lastAutoScrolledActiveHref = href;
			}
		});
	});
</script>

<div class="epub-toc-panel">
	{#if loading}
		<EpubLoadingState message={'正在加载目录…'} surface />
	{:else if loadFailed}
		<div class="epub-placeholder">{'目录加载失败，请稍后重试'}</div>
	{:else if flatItems.length === 0}
		<div class="epub-placeholder">{'此书暂无目录'}</div>
	{:else}
		<div
			class="epub-toc-list"
			bind:this={tocListEl}
			aria-label={'目录'}
		>
			{#each flatItems as item, itemIndex (item.id)}
				{@const isActive = isActiveItem(item)}
				{@const isLastRead = isLastReadItem(item)}
				<div
					class="epub-toc-item"
					class:active={isActive}
					class:is-last-read={isLastRead}
					style={`--toc-depth:${item.depth};`}
					onclick={() => handleClick(item)}
					onkeydown={(event) => handleKeydown(event, item)}
					role="button"
					tabindex="0"
					aria-current={isActive ? 'location' : undefined}
					aria-label={resolveItemAriaLabel(item, isActive, isLastRead)}
					data-last-read={isLastRead ? 'true' : undefined}
					data-item-id={item.id}
				>
					<span class="toc-bullet" aria-hidden="true"></span>
					<span class="toc-title">{item.label}</span>
					<span class="toc-trailing">
						{#if isActive}
							<span
								class="toc-current-location-marker"
								title={'当前阅读位置'}
								aria-label={'当前阅读位置'}
							>
								<span class="toc-current-location-icon" aria-hidden="true" use:currentLocationIcon></span>
							</span>
						{/if}
						{#if isLastRead}
							<span
								class="toc-last-read-marker"
								title={'上次阅读位置'}
								aria-label={'上次阅读'}
							>
								<span class="toc-last-read-icon" aria-hidden="true" use:lastReadIcon></span>
								<span class="toc-last-read-badge">{'上次阅读'}</span>
							</span>
						{/if}
						{#if item.pageNumber}
							<span class="toc-page">{item.pageNumber}</span>
						{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.epub-toc-panel {
		display: flex;
		flex-direction: column;
		padding: 10px 0 18px;
	}

	.epub-placeholder {
		margin: 4px 12px 0;
		padding: 22px 14px;
		border-radius: 16px;
		background: color-mix(in srgb, var(--weave-elevated-background, var(--background-secondary)) 88%, transparent);
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.7;
	}

	.epub-toc-list {
		display: flex;
		flex-direction: column;
	}

	.epub-toc-item {
		--indent: calc(var(--toc-depth, 0) * 18px);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px 8px calc(16px + var(--indent));
		color: var(--text-muted);
		cursor: pointer;
		border-left: 2px solid transparent;
		transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.epub-toc-item:hover,
	.epub-toc-item:focus-visible {
		background: color-mix(in srgb, var(--background-modifier-hover) 88%, transparent);
		color: var(--text-normal);
		outline: none;
	}

	.epub-toc-item.active {
		background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
		color: var(--text-normal);
		border-left-color: var(--interactive-accent);
	}

	.epub-toc-item.is-last-read.active {
		border-left-color: var(--interactive-accent);
	}

	.toc-bullet {
		flex: 0 0 auto;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-faint) 72%, transparent);
	}

	.epub-toc-item.active .toc-bullet {
		background: var(--interactive-accent);
	}

	.toc-title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 13px;
		line-height: 1.55;
		word-break: break-word;
	}

	.toc-trailing {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin-left: auto;
		padding-left: 10px;
		white-space: nowrap;
	}

	.toc-page {
		flex: 0 0 auto;
		min-width: 2ch;
		text-align: right;
		color: var(--text-faint);
		font-size: 12px;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.epub-toc-item.active .toc-page {
		color: color-mix(in srgb, var(--interactive-accent) 72%, var(--text-muted) 28%);
	}

	.toc-last-read-marker {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 2px 7px 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--interactive-accent) 14%, var(--background-primary));
		border: 1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border));
		color: var(--interactive-accent);
	}

	.toc-last-read-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 12px;
		height: 12px;
		color: inherit;
	}

	.toc-last-read-icon :global(svg) {
		width: 11px;
		height: 11px;
	}

	.toc-last-read-badge {
		font-size: 10px;
		font-weight: var(--font-medium, 600);
		line-height: 1;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.toc-current-location-marker {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--interactive-accent);
	}

	.toc-current-location-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 14px;
		height: 14px;
		color: inherit;
	}

	.toc-current-location-icon :global(svg) {
		width: 13px;
		height: 13px;
	}
</style>
