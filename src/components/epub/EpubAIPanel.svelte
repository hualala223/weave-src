<script lang="ts">
	import { MarkdownRenderer, Notice } from 'obsidian';
	import type { App, Component } from 'obsidian';
	import { onMount, untrack } from 'svelte';
	import { runBzAIChatStream, type BzAIChatMessage } from '../../services/ai/bz-ai';

	// 该发型 Obsidian 类型的 MarkdownRenderer 无 unrender；render 需组件宿主。
	// 传一个最小 shim（不持有子粒度，超时/重渲染靠 innerHTML 清空兜底）。
	const markdownRenderShim = {
		addChild(): void {},
		removeChild(): void {},
	} as unknown as Component;

	type QuickAction = 'lookup' | 'explain' | 'translate';

	interface Props {
		open: boolean;
		app: App;
		text: string;
		onClose: () => void;
	}

	let { open, app, text, onClose }: Props = $props();

	let action = $state<QuickAction>('lookup');
	let result = $state('');
	let loading = $state(false);
	let error = $state('');
	let markdownEl = $state<HTMLDivElement | undefined>(undefined);

	function buildMessages(target: QuickAction, selectedText: string): BzAIChatMessage[] {
		const user: BzAIChatMessage = { role: 'user', content: selectedText };
		switch (target) {
			case 'lookup':
				return [
					{
						role: 'system',
						content:
							'你是一副词典。请为下面选中的文本给出词典式释义：若为英文单词/短语，给出音标、词性、释义（优先中文）、常用搭配与一个例句；若为中文词语，给出解释并附英文对应。保持简洁、分条。',
					},
					user,
				];
			case 'explain':
				return [
					{
						role: 'system',
						content: '请解释下面这段文字的含义与语境，帮助读者理解。保持简洁，可结合上下文。',
					},
					user,
				];
			case 'translate':
				return [
					{
						role: 'system',
						content: '如果这段内容不是中文，请翻译成中文；如果本已是中文，请翻译成英文。保留结构与语气，只输出译文。',
					},
					user,
				];
		}
	}

	async function run(target: QuickAction): Promise<void> {
		const selectedText = String(text || '').trim();
		if (!selectedText || loading) {
			return;
		}
		action = target;
		loading = true;
		error = '';
		result = '';
		try {
			await runBzAIChatStream(
				app,
				buildMessages(target, selectedText),
				{
					onDelta: (delta) => {
						result += delta;
					},
				},
				{ maxTokens: 2048, temperature: 0.7 },
			);
		} catch (e) {
			result = '';
			error = e instanceof Error ? e.message : 'AI 请求失败';
		} finally {
			loading = false;
		}
	}

	async function copyResult(): Promise<void> {
		const content = result.trim();
		if (!content) {
			return;
		}
		try {
			await navigator.clipboard.writeText(content);
			new Notice('已复制 AI 结果');
		} catch (_e) {
			new Notice('复制失败');
		}
	}

	// AI 输出以 Markdown 渲染；渲染失败时回退为纯文本。
	$effect(() => {
		const content = result;
		const el = markdownEl;
		if (!content || loading || !el) {
			return;
		}
		untrack(() => {
			el.innerHTML = '';
			void MarkdownRenderer.render(app, content, el, '', markdownRenderShim).catch(() => {
				el.textContent = content;
			});
		});
	});

	$effect(() => {
		if (!open) {
			return;
		}
		// 每次打开：重置并自动执行「查词」。用 untrack 隔离，避免 loading 翻转反触发本 effect 造成重复请求。
		untrack(() => {
			loading = false;
			error = '';
			result = '';
			action = 'lookup';
			void run('lookup');
		});
	});

	function handleMaskPointerDown(event: PointerEvent) {
		const target = event.target as HTMLElement | null;
		if (target && target.classList.contains('epub-ai-panel-mask')) {
			onClose();
		}
	}

	onMount(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && open) {
				onClose();
				event.stopPropagation();
			}
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => document.removeEventListener('keydown', onKeyDown, true);
	});
</script>

{#if open}
	<div class="epub-ai-panel-mask" onpointerdown={handleMaskPointerDown}>
		<div class="epub-ai-panel" role="dialog" aria-label="AI">
			<div class="epub-ai-panel-head">
				<h3>AI</h3>
				<button type="button" class="epub-ai-panel-close" onclick={onClose} aria-label="关闭">✕</button>
			</div>

			<div class="epub-ai-panel-quote">{text}</div>

			<div class="epub-ai-panel-actions">
				<button type="button" class="epub-ai-pill" class:active={action === 'lookup'} onclick={() => void run('lookup')}>
					查词
				</button>
				<button type="button" class="epub-ai-pill" class:active={action === 'explain'} onclick={() => void run('explain')}>
					解释
				</button>
				<button type="button" class="epub-ai-pill" class:active={action === 'translate'} onclick={() => void run('translate')}>
					翻译
				</button>
			</div>

			<div class="epub-ai-panel-body">
				{#if loading && !result}
					<div class="epub-ai-panel-loading">思考中…</div>
				{:else if loading && result}
					<pre class="epub-ai-panel-result">{result}</pre>
				{:else if error}
					<div class="epub-ai-panel-error">{error}</div>
				{:else if result}
					<div class="epub-ai-panel-result-md" bind:this={markdownEl}></div>
				{:else}
					<div class="epub-ai-panel-empty">选择上方动作查看 AI 结果</div>
				{/if}
			</div>

			{#if result && !loading}
				<div class="epub-ai-panel-foot">
					<button type="button" class="epub-ai-copy-btn" onclick={() => void copyResult()}>复制结果</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.epub-ai-panel-mask {
		position: fixed;
		inset: 0;
		z-index: 998;
		background: var(--background-modifier-cover);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.epub-ai-panel {
		position: relative;
		width: 92%;
		max-width: 700px;
		max-height: 82vh;
		display: flex;
		flex-direction: column;
		background: var(--background-primary);
		border-radius: 12px;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.22);
		overflow: hidden;
		animation: epub-ai-panel-in 0.22s ease-out;
	}

	@keyframes epub-ai-panel-in {
		from {
			opacity: 0;
			transform: translateY(10px) scale(0.985);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.epub-ai-panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px 8px;
	}

	.epub-ai-panel-head h3 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		color: var(--text-normal);
	}

	.epub-ai-panel-close {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 15px;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.epub-ai-panel-close:hover {
		background: var(--background-secondary);
		color: var(--text-normal);
	}

	.epub-ai-panel-quote {
		margin: 4px 20px 10px;
		padding: 8px 12px;
		border-radius: 6px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		max-height: 96px;
		overflow: auto;
		word-break: break-word;
	}

	.epub-ai-panel-actions {
		display: flex;
		gap: 8px;
		padding: 0 20px 10px;
		flex-wrap: wrap;
	}

	.epub-ai-pill {
		padding: 6px 16px;
		border-radius: 20px;
		background: var(--background-secondary);
		color: var(--text-muted);
		font-size: 14px;
		border: none;
		cursor: pointer;
		opacity: 0.7;
		transition: all 0.2s;
	}

	.epub-ai-pill:hover {
		opacity: 1;
	}

	.epub-ai-pill.active {
		opacity: 1;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	.epub-ai-panel-body {
		flex: 1;
		min-height: 120px;
		max-height: 46vh;
		overflow: auto;
		padding: 0 20px 16px;
	}

	.epub-ai-panel-loading,
	.epub-ai-panel-empty {
		color: var(--text-faint);
		font-size: 14px;
		padding: 18px 4px;
	}

	.epub-ai-panel-error {
		color: var(--text-error);
		font-size: 13px;
		padding: 14px 4px;
		white-space: pre-wrap;
	}

	.epub-ai-panel-result {
		margin: 0;
		font-family: inherit;
		font-size: 14px;
		line-height: 1.65;
		color: var(--text-normal);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.epub-ai-panel-result-md {
		font-size: 14px;
		line-height: 1.65;
		color: var(--text-normal);
		word-break: break-word;
	}

	.epub-ai-panel-result-md :global(p) {
		margin: 0 0 8px;
	}

	.epub-ai-panel-result-md :global(p:last-child) {
		margin-bottom: 0;
	}

	.epub-ai-panel-result-md :global(ul),
	.epub-ai-panel-result-md :global(ol) {
		margin: 0 0 8px;
		padding-left: 22px;
	}

	.epub-ai-panel-result-md :global(h1),
	.epub-ai-panel-result-md :global(h2),
	.epub-ai-panel-result-md :global(h3),
	.epub-ai-panel-result-md :global(h4) {
		margin: 10px 0 6px;
		font-weight: 600;
		line-height: 1.3;
	}

	.epub-ai-panel-result-md :global(code) {
		background: var(--background-secondary);
		border-radius: 4px;
		padding: 1px 5px;
		font-size: 12.5px;
	}

	.epub-ai-panel-result-md :global(pre) {
		background: var(--background-secondary);
		border-radius: 6px;
		padding: 8px 10px;
		overflow: auto;
	}

	.epub-ai-panel-result-md :global(pre code) {
		background: transparent;
		padding: 0;
	}

	.epub-ai-panel-result-md :global(blockquote) {
		margin: 0 0 8px;
		padding: 4px 10px;
		border-left: 3px solid var(--background-modifier-border);
		color: var(--text-muted);
	}

	.epub-ai-panel-result-md :global(a) {
		color: var(--text-accent);
	}

	.epub-ai-panel-result-md :global(strong) {
		font-weight: 600;
	}

	.epub-ai-panel-foot {
		display: flex;
		justify-content: flex-end;
		padding: 10px 20px 16px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.epub-ai-copy-btn {
		padding: 8px 18px;
		border-radius: 6px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		font-weight: 500;
		font-size: 14px;
		cursor: pointer;
	}

	.epub-ai-copy-btn:hover {
		filter: brightness(1.08);
	}
</style>
