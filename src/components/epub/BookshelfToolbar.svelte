<script lang="ts">
	import { obsidianIcon } from '../../utils/obsidian-icon-action';

	export interface BookshelfToolbarProps {
		searching: boolean;
		backButtonLabel: string;
		t: (key: string) => string;
		onImport: () => void | Promise<void>;
		onToggleSearch: () => void;
		onBack: () => void | Promise<void>;
		onSettings: (event: MouseEvent) => void;
	}

	let {
		searching = false,
		backButtonLabel,
		t,
		onImport,
		onToggleSearch,
		onBack,
		onSettings,
	}: BookshelfToolbarProps = $props();

</script>

<div class="epub-bookshelf-toolbar nav-header" role="toolbar" aria-label={'书架功能栏'}>
	<div class="epub-bookshelf-actions nav-buttons-container">
		<button
			type="button"
			class="epub-toolbar-btn clickable-icon nav-action-button"
			title={'导入书籍'}
			aria-label={'导入书籍'}
			onclick={() => void onImport()}
		>
			<span use:obsidianIcon={'scan-search'}></span>
		</button>
		<button
			type="button"
			class="epub-toolbar-btn clickable-icon nav-action-button"
			title={searching ? '关闭搜索并清空条件' : '搜索与筛选'}
			aria-label={searching ? '关闭搜索并清空条件' : '搜索与筛选'}
			onclick={onToggleSearch}
		>
			<span use:obsidianIcon={searching ? 'x' : 'search'}></span>
		</button>
		<button
			type="button"
			class="epub-toolbar-btn clickable-icon nav-action-button"
			title={backButtonLabel}
			aria-label={backButtonLabel}
			onclick={() => void onBack()}
		>
			<span use:obsidianIcon={'arrow-left'}></span>
		</button>
		<button
			type="button"
			class="epub-toolbar-btn clickable-icon nav-action-button"
			title={'设置'}
			aria-label={'设置'}
			onclick={onSettings}
		>
			<span use:obsidianIcon={'settings'}></span>
		</button>
	</div>
</div>
