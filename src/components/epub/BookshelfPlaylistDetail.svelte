<script lang="ts">
	import BookshelfListBookItem from './BookshelfListBookItem.svelte';
	import type { BookshelfListBookItemData } from './BookshelfListBookItem.svelte';

	export interface BookshelfPlaylistDetailBook extends BookshelfListBookItemData {
		coverUrl?: string | null;
	}

	export interface BookshelfPlaylistDetailProps {
		books: BookshelfPlaylistDetailBook[];
		emptyMessage?: string;
		showProgress?: boolean;
		onOpenBook: (path: string) => void;
		onBookContextMenu: (event: MouseEvent, path: string) => void;
		onBookKeydown: (event: KeyboardEvent, path: string) => void;
	}

	let {
		books,
		emptyMessage,
		showProgress = false,
		onOpenBook,
		onBookContextMenu,
		onBookKeydown,
	}: BookshelfPlaylistDetailProps = $props();

	const resolvedEmptyMessage = $derived(emptyMessage ?? '此书单还没有书籍。可在书架书籍的右键菜单中加入。');
</script>

<div class="epub-bookshelf-playlist-detail">
	{#if books.length === 0}
		<div class="epub-bookshelf-playlist-detail__empty">
			{resolvedEmptyMessage}
		</div>
	{:else}
		<div class="epub-bookshelf-playlist-detail__books">
			{#each books as book, index (book.path)}
				<BookshelfListBookItem
					file={book}
					{index}
					animateEntry={false}
					coverUrl={book.coverUrl ?? null}
					isOpening={false}
					isContinueReading={false}
					{showProgress}
					onOpen={onOpenBook}
					onContextMenu={onBookContextMenu}
					onKeydown={onBookKeydown}
				/>
			{/each}
		</div>
	{/if}
</div>
