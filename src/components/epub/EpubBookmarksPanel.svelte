<script lang="ts">
	import { setIcon, type App } from 'obsidian';
	import { onMount } from 'svelte';
	import EpubLoadingState from './EpubLoadingState.svelte';
	import { logger } from '../../utils/logger';
	import { EpubBookmarkService, type EpubBookmarkNote, type EpubBookmarkRecord } from '../../services/epub/EpubBookmarkService';
	import type { EpubBook } from '../../services/epub';

	interface Props {
		app: App;
		book: EpubBook | null;
		bookmarkRevision?: number;
		onDeleteBookmark?: (bookmark: EpubBookmarkRecord) => Promise<boolean | void>;
		onAddBookmarkNote?: (bookmark: EpubBookmarkRecord, text: string) => Promise<boolean>;
		onUpdateBookmarkNote?: (bookmark: EpubBookmarkRecord, noteId: string, text: string) => Promise<boolean>;
		onDeleteBookmarkNote?: (bookmark: EpubBookmarkRecord, noteId: string) => Promise<boolean>;
		onNavigate?: (cfi: string, text?: string) => void;
	}

	let {
		app,
		book,
		bookmarkRevision = 0,
		onDeleteBookmark,
		onAddBookmarkNote,
		onUpdateBookmarkNote,
		onDeleteBookmarkNote,
		onNavigate,
	}: Props = $props();
	let bookmarks = $state<EpubBookmarkRecord[]>([]);
	let loading = $state(false);
	let hasLoadedOnce = $state(false);
	let deletingBookmarkId = $state('');
	let expandedBookmarkId = $state('');
	let composerText = $state('');
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let editingNoteId = $state('');
	let editingText = $state('');
	let confirmingDeleteId = $state('');
	let busyKey = $state('');
	let loadToken = 0;
	let panelDisposed = false;
	let lastContextKey = '';
	let loadedBookId = '';

	function getBookmarkService(): EpubBookmarkService {
		return new EpubBookmarkService(app);
	}

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				node.replaceChildren();
				setIcon(node, newName);
			}
		};
	}

	function formatTime(timestamp: number): string {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, '0');
		const d = String(date.getDate()).padStart(2, '0');
		const h = String(date.getHours()).padStart(2, '0');
		const min = String(date.getMinutes()).padStart(2, '0');
		return `${y}-${m}-${d} ${h}:${min}`;
	}

	function formatShortTime(timestamp: number): string {
		// 与 formatTime 同格式，只截掉年份前缀：MM-DD HH:mm
		return formatTime(timestamp).slice(5);
	}

	function getChapterLabel(bookmark: EpubBookmarkRecord): string {
		return String(bookmark.chapterTitle || '').trim()
			|| `第 ${bookmark.chapterIndex + 1} 章`;
	}

	function getPageLabel(bookmark: EpubBookmarkRecord): string {
		if (typeof bookmark.pageNumber === 'number' && bookmark.pageNumber > 0) {
			return `p.${bookmark.pageNumber}`;
		}
		return '';
	}

	function navigateToBookmark(bookmark: EpubBookmarkRecord) {
		if (!bookmark.cfi) {
			return;
		}
		onNavigate?.(bookmark.cfi, bookmark.chapterTitle || getPageLabel(bookmark));
	}

	function requestDeleteBookmark(event: MouseEvent, bookmark: EpubBookmarkRecord) {
		event.preventDefault();
		event.stopPropagation();
		if (!onDeleteBookmark || deletingBookmarkId === bookmark.id) {
			return;
		}
		// 有备注时先确认：删除书签会连带删除整串备注。
		if ((bookmark.notes?.length ?? 0) > 0) {
			confirmingDeleteId = bookmark.id;
			return;
		}
		void performDeleteBookmark(bookmark);
	}

	async function confirmDeleteBookmark(bookmark: EpubBookmarkRecord) {
		confirmingDeleteId = '';
		await performDeleteBookmark(bookmark);
	}

	async function performDeleteBookmark(bookmark: EpubBookmarkRecord) {
		if (!onDeleteBookmark || deletingBookmarkId === bookmark.id) {
			return;
		}
		deletingBookmarkId = bookmark.id;
		try {
			const deleted = await onDeleteBookmark(bookmark);
			if (deleted === false) {
				return;
			}
			bookmarks = bookmarks.filter((item) => item.id !== bookmark.id);
			if (expandedBookmarkId === bookmark.id) {
				closeNoteEditor();
			}
		} catch (error) {
			logger.error('[EpubBookmarksPanel] Failed to delete bookmark:', error);
		} finally {
			if (deletingBookmarkId === bookmark.id) {
				deletingBookmarkId = '';
			}
		}
	}

	function toggleNoteEditor(bookmark: EpubBookmarkRecord) {
		if (expandedBookmarkId === bookmark.id) {
			closeNoteEditor();
			return;
		}
		expandedBookmarkId = bookmark.id;
		resetNoteEditorState();
	}

	function closeNoteEditor() {
		expandedBookmarkId = '';
		resetNoteEditorState();
	}

	function resetNoteEditorState() {
		composerText = '';
		editingNoteId = '';
		editingText = '';
		confirmingDeleteId = '';
	}

	async function saveNewNote(bookmark: EpubBookmarkRecord) {
		const text = composerText ?? '';
		if (!text.trim() || busyKey) {
			return;
		}
		if (!onAddBookmarkNote) {
			composerText = '';
			return;
		}
		busyKey = 'add';
		try {
			const saved = await onAddBookmarkNote(bookmark, text);
			if (saved) {
				composerText = '';
			}
		} catch (error) {
			logger.error('[EpubBookmarksPanel] Failed to add bookmark note:', error);
		} finally {
			busyKey = '';
		}
	}

	function startEditNote(note: EpubBookmarkNote) {
		editingNoteId = note.id;
		editingText = note.text;
	}

	function cancelEditNote() {
		editingNoteId = '';
		editingText = '';
	}

	async function saveEditNote(bookmark: EpubBookmarkRecord, note: EpubBookmarkNote) {
		const text = editingText ?? '';
		if (!text.trim() || busyKey) {
			return;
		}
		if (!onUpdateBookmarkNote) {
			cancelEditNote();
			return;
		}
		busyKey = `edit:${note.id}`;
		try {
			const saved = await onUpdateBookmarkNote(bookmark, note.id, text);
			if (saved) {
				cancelEditNote();
			}
		} catch (error) {
			logger.error('[EpubBookmarksPanel] Failed to update bookmark note:', error);
		} finally {
			busyKey = '';
		}
	}

	async function removeNote(bookmark: EpubBookmarkRecord, note: EpubBookmarkNote) {
		if (busyKey || !onDeleteBookmarkNote) {
			return;
		}
		busyKey = `delnote:${note.id}`;
		try {
			await onDeleteBookmarkNote(bookmark, note.id);
		} catch (error) {
			logger.error('[EpubBookmarksPanel] Failed to delete bookmark note:', error);
		} finally {
			busyKey = '';
		}
	}

	function handleNoteKeyShortcut(event: KeyboardEvent, onEscape: () => void, onSave: () => void) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onEscape();
		} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			onSave();
		}
	}

	function handleComposerKeydown(event: KeyboardEvent, bookmark: EpubBookmarkRecord) {
		handleNoteKeyShortcut(event, () => closeNoteEditor(), () => void saveNewNote(bookmark));
	}

	function handleEditKeydown(event: KeyboardEvent, bookmark: EpubBookmarkRecord, note: EpubBookmarkNote) {
		handleNoteKeyShortcut(event, () => cancelEditNote(), () => void saveEditNote(bookmark, note));
	}

	$effect(() => {
		if (expandedBookmarkId) {
			queueMicrotask(() => composerEl?.focus({ preventScroll: true }));
		}
	});

	function isStaleLoad(currentToken: number, expectedBookId: string): boolean {
		return panelDisposed || currentToken !== loadToken || (book?.id ?? '') !== expectedBookId;
	}

	async function loadBookmarks() {
		const currentBook = book;
		if (!currentBook) {
			bookmarks = [];
			loading = false;
			return;
		}
		const currentToken = ++loadToken;
		loading = true;
		try {
			const loaded = await getBookmarkService().loadBookmarksForBook(currentBook);
			if (isStaleLoad(currentToken, currentBook.id)) {
				return;
			}
			bookmarks = loaded;
			hasLoadedOnce = true;
			loadedBookId = currentBook.id;
		} catch (error) {
			if (isStaleLoad(currentToken, currentBook.id)) {
				return;
			}
			logger.error('[EpubBookmarksPanel] Failed to load bookmarks:', error);
			bookmarks = [];
		} finally {
			if (!isStaleLoad(currentToken, currentBook.id)) {
				loading = false;
			}
		}
	}

	$effect(() => {
		const contextKey = [book?.id ?? '', String(bookmarkRevision)].join('::');
		if (book) {
			if (contextKey === lastContextKey) {
				return;
			}
			lastContextKey = contextKey;
			if (book.id !== loadedBookId) {
				// 换书：清掉旧书列表，恢复新书首载加载态
				bookmarks = [];
				hasLoadedOnce = false;
			}
			void loadBookmarks();
		} else {
			loadToken += 1;
			bookmarks = [];
			loading = false;
			hasLoadedOnce = false;
			lastContextKey = '';
			loadedBookId = '';
		}
	});

	onMount(() => {
		return () => {
			panelDisposed = true;
			loadToken += 1;
		};
	});
</script>

<div class="epub-bookmarks-panel">
	{#if loading && !hasLoadedOnce}
		<div class="bm-empty">
			<EpubLoadingState message={'正在加载书签…'} />
		</div>
	{:else if bookmarks.length === 0}
		<div class="bm-empty">
			<div class="bm-empty-label">{'暂无书签'}</div>
			<div class="bm-empty-hint">{'点击阅读器顶部书签按钮即可保存当前位置'}</div>
		</div>
	{:else}
		<div class="bm-list">
			{#each bookmarks as bookmark (bookmark.id)}
				{@const pageLabel = getPageLabel(bookmark)}
				{@const createdTime = formatTime(bookmark.createdAt)}
				{@const hasNotes = (bookmark.notes?.length ?? 0) > 0}
				{@const isExpanded = expandedBookmarkId === bookmark.id}
				<div
					class="bm-item"
					class:bm-item--expanded={isExpanded}
					class:bm-item--confirming={confirmingDeleteId === bookmark.id}
				>
					<button class="bm-item-main" type="button" onclick={() => navigateToBookmark(bookmark)} aria-label={`跳转到 ${getChapterLabel(bookmark)}`}>
						<span class="bm-item-meta-row bm-item-meta-row--top">
							<span class="bm-item-time" title={createdTime}>{createdTime}</span>
							{#if pageLabel}
								<span class="bm-item-page">{pageLabel}</span>
							{/if}
						</span>
						<span class="bm-item-content-row">
							<span class="bm-item-title">{getChapterLabel(bookmark)}</span>
						</span>
					</button>
					{#if onDeleteBookmark && confirmingDeleteId !== bookmark.id}
						<button
							class="bm-item-note"
							type="button"
							onclick={() => toggleNoteEditor(bookmark)}
							aria-label={isExpanded ? '收起备注' : (hasNotes ? '编辑备注' : '添加备注')}
							title={'备注'}
						>
							<span class="bm-item-note-icon" use:icon={'pencil'}></span>
						</button>
						<button
							class="bm-item-delete"
							type="button"
							onclick={(event) => requestDeleteBookmark(event, bookmark)}
							aria-label={`删除书签 ${getChapterLabel(bookmark)}`}
							title={'删除书签'}
							disabled={deletingBookmarkId === bookmark.id}
						>
							<span class="bm-item-delete-icon" use:icon={'trash-2'}></span>
						</button>
					{/if}
					{#if isExpanded}
						<div class="bm-note-editor">
							<textarea
								bind:value={composerText}
								bind:this={composerEl}
								class="bm-note-input"
								rows={3}
								placeholder="写下这页的备注或感想…"
								onkeydown={(event) => handleComposerKeydown(event, bookmark)}
							></textarea>
							<div class="bm-note-actions">
								<button
									class="bm-note-save"
									type="button"
									onclick={() => void saveNewNote(bookmark)}
									disabled={!composerText.trim() || busyKey !== ''}
								>{'保存'}</button>
								<button class="bm-note-cancel" type="button" onclick={closeNoteEditor}>{'收起'}</button>
							</div>
							{#if !hasNotes}
								<div class="bm-note-empty">{'暂无备注'}</div>
							{:else}
								<div class="bm-note-list">
									{#each bookmark.notes as note (note.id)}
										<div class="bm-note-item">
											{#if editingNoteId === note.id}
												<textarea
													bind:value={editingText}
													class="bm-note-input"
													rows={2}
													placeholder="编辑备注…"
													onkeydown={(event) => handleEditKeydown(event, bookmark, note)}
												></textarea>
												<div class="bm-note-actions">
													<button
														class="bm-note-save"
														type="button"
														onclick={() => void saveEditNote(bookmark, note)}
														disabled={!editingText.trim() || busyKey !== ''}
													>{'保存'}</button>
													<button class="bm-note-cancel" type="button" onclick={cancelEditNote}>{'取消'}</button>
												</div>
											{:else}
												<div class="bm-note-meta">
													<span class="bm-note-time">{formatShortTime(note.createdAt)}</span>
													<span class="bm-note-actions-row">
														<button class="bm-note-action" type="button" onclick={() => startEditNote(note)} aria-label="编辑备注">{'编辑'}</button>
														<button class="bm-note-action" type="button" onclick={() => void removeNote(bookmark, note)} aria-label="删除备注" disabled={busyKey === `delnote:${note.id}`}>{'删除'}</button>
													</span>
												</div>
												<div class="bm-note-text">{note.text}</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
					{#if confirmingDeleteId === bookmark.id}
						<div class="bm-confirm-bar">
							<span class="bm-confirm-label">{`删除该书签将同时删除 ${bookmark.notes?.length ?? 0} 条备注`}</span>
							<span class="bm-confirm-actions">
								<button class="bm-confirm-danger" type="button" onclick={() => void confirmDeleteBookmark(bookmark)} disabled={deletingBookmarkId === bookmark.id}>{'确认删除'}</button>
								<button class="bm-confirm-cancel" type="button" onclick={() => (confirmingDeleteId = '')}>{'取消'}</button>
							</span>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	 {/if}
 </div>

 <style>
	.epub-bookmarks-panel {
 		display: flex;
 		flex-direction: column;
 		padding: 0;
 		height: 100%;
		font-family: var(--font-interface, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
 	}

 	.bm-empty {
 		display: flex;
 		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 40px 20px;
		text-align: center;
 	}

 	.bm-empty-label {
 		font-size: 13px;
 		font-weight: 500;
 		color: var(--text-muted);
 	}

 	.bm-empty-hint {
 		font-size: 12px;
 		color: var(--text-faint);
 		line-height: 1.5;
 		max-width: 220px;
 	}

 	.bm-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 8px 12px 12px;
	}

	.bm-item {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--background-primary) 88%, var(--background-secondary) 12%);
		transition: background 0.12s ease, border-color 0.12s ease;
	}

	.bm-item:hover,
	.bm-item:focus-within {
		background: color-mix(in srgb, var(--background-modifier-hover) 50%, var(--background-primary) 50%);
		border-color: color-mix(in srgb, var(--interactive-accent) 24%, var(--background-modifier-border) 76%);
	}

	.bm-item-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		min-height: 82px;
		padding: 12px 16px 12px 16px;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		font: inherit;
		color: inherit;
	}

	.bm-item-main:focus-visible {
		outline: none;
	}

	.bm-item-meta-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		min-width: 0;
		font-size: 11px;
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
	}

	.bm-item-title {
		min-width: 0;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-normal);
		line-height: 1.5;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.bm-item-content-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding-right: 76px;
	}

	.bm-item-page {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.4;
		min-width: 0;
		white-space: nowrap;
		margin-left: auto;
	}

	.bm-item-time {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.4;
		text-align: left;
		white-space: nowrap;
	}

	.bm-item-delete {
		position: absolute;
		bottom: 10px;
		right: 10px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		margin: 0;
		appearance: none;
		-webkit-appearance: none;
		border: none !important;
		border-radius: 6px;
		background: transparent !important;
		background-color: transparent !important;
		box-shadow: none !important;
		color: var(--text-faint);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
	}

	.bm-item-delete:hover:not(:disabled) {
		border: none !important;
		box-shadow: none !important;
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent) !important;
		color: var(--text-error);
	}

	.bm-item-delete:focus-visible:not(:disabled) {
		outline: 2px solid color-mix(in srgb, var(--interactive-accent) 50%, transparent);
		outline-offset: 2px;
		border: none !important;
		box-shadow: none !important;
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent) !important;
		color: var(--text-error);
	}

	.bm-item-delete:disabled {
		opacity: 0.5;
		cursor: default;
		border: none !important;
		box-shadow: none !important;
		background: transparent !important;
	}

	.bm-item-delete-icon {
		width: 16px;
		height: 16px;
	}

	.bm-item-delete-icon :global(.svg-icon) {
		width: 16px;
		height: 16px;
	}

	.bm-item--expanded {
		border-color: color-mix(in srgb, var(--interactive-accent) 32%, var(--background-modifier-border) 68%);
	}

	.bm-item--confirming {
		border-color: color-mix(in srgb, var(--color-red, var(--text-error)) 40%, var(--background-modifier-border) 60%);
	}

	.bm-item-note {
		position: absolute;
		bottom: 10px;
		right: 44px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		margin: 0;
		appearance: none;
		-webkit-appearance: none;
		border: none !important;
		border-radius: 6px;
		background: transparent !important;
		background-color: transparent !important;
		box-shadow: none !important;
		color: var(--text-faint);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.bm-item-note:hover {
		border: none !important;
		box-shadow: none !important;
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent) !important;
		color: var(--interactive-accent);
	}

	.bm-item-note:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--interactive-accent) 50%, transparent);
		outline-offset: 2px;
		border: none !important;
		box-shadow: none !important;
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent) !important;
		color: var(--interactive-accent);
	}

	.bm-item-note-icon {
		width: 16px;
		height: 16px;
	}

	.bm-item-note-icon :global(.svg-icon) {
		width: 16px;
		height: 16px;
	}

	.bm-note-editor {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		padding: 8px 12px 14px;
		border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
		animation: bm-note-fade-in 0.12s ease;
	}

	@keyframes bm-note-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.bm-note-input {
		display: block;
		width: 100%;
		min-height: 72px;
		padding: 8px 10px;
		margin: 0;
		font: inherit;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-normal);
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		resize: vertical;
		box-sizing: border-box;
	}

	.bm-note-input:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--interactive-accent) 60%, var(--background-modifier-border) 40%);
	}

	.bm-note-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.bm-note-save,
	.bm-note-cancel {
		appearance: none;
		-webkit-appearance: none;
		padding: 4px 12px;
		font: inherit;
		font-size: 12px;
		line-height: 1.4;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
	}

	.bm-note-save {
		border: none;
		background: color-mix(in srgb, var(--interactive-accent) 16%, transparent);
		color: var(--interactive-accent);
	}

	.bm-note-save:hover:not(:disabled) {
		background: color-mix(in srgb, var(--interactive-accent) 26%, transparent);
	}

	.bm-note-save:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.bm-note-cancel {
		border: 1px solid var(--background-modifier-border);
		background: transparent;
		color: var(--text-muted);
	}

	.bm-note-cancel:hover {
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent);
	}

	.bm-note-empty {
		padding: 2px 2px 0;
		font-size: 12px;
		color: var(--text-faint);
	}

	.bm-note-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 10px;
		border-top: 1px dashed color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
	}

	.bm-note-item {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px;
		border-left: 3px solid color-mix(in srgb, var(--interactive-accent) 35%, transparent);
		border-radius: 0 8px 8px 0;
		background: color-mix(in srgb, var(--background-secondary) 40%, transparent);
	}

	.bm-note-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-width: 0;
	}

	.bm-note-time {
		font-size: 11px;
		color: var(--text-faint);
		line-height: 1.4;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.bm-note-actions-row {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s ease;
	}

	.bm-note-item:hover .bm-note-actions-row,
	.bm-note-item:focus-within .bm-note-actions-row {
		opacity: 1;
		pointer-events: auto;
	}

	@media (hover: none) {
		.bm-note-actions-row {
			opacity: 1;
			pointer-events: auto;
		}
	}

	.bm-note-action {
		appearance: none;
		-webkit-appearance: none;
		padding: 2px 6px;
		margin: 0;
		font: inherit;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-faint);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: color 0.12s ease, background 0.12s ease;
	}

	.bm-note-action:hover:not(:disabled) {
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent);
		color: var(--interactive-accent);
	}

	.bm-note-action:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.bm-note-text {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-normal);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.bm-confirm-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		border-top: 1px solid color-mix(in srgb, var(--color-red, var(--text-error)) 30%, transparent);
		background: color-mix(in srgb, var(--color-red, var(--text-error)) 8%, transparent);
	}

	.bm-confirm-label {
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-error);
		min-width: 0;
	}

	.bm-confirm-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.bm-confirm-danger,
	.bm-confirm-cancel {
		appearance: none;
		-webkit-appearance: none;
		padding: 4px 10px;
		font: inherit;
		font-size: 12px;
		line-height: 1.4;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
	}

	.bm-confirm-danger {
		border: none;
		background: color-mix(in srgb, var(--color-red, var(--text-error)) 18%, transparent);
		color: var(--text-error);
	}

	.bm-confirm-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-red, var(--text-error)) 28%, transparent);
	}

	.bm-confirm-danger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.bm-confirm-cancel {
		border: 1px solid var(--background-modifier-border);
		background: transparent;
		color: var(--text-muted);
	}

	.bm-confirm-cancel:hover {
		background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent);
	}
 </style>
