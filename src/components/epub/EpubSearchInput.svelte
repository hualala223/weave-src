<script lang="ts">
  import { onMount } from 'svelte';
  import { vaultStorage } from '../../utils/vault-local-storage';
  import { Menu, type App } from 'obsidian';
  import EnhancedIcon from '../ui/EnhancedIcon.svelte';
  import FloatingMenu from '../ui/FloatingMenu.svelte';
  import { ICON_NAMES } from '../../icons/index';
  import { logger } from '../../utils/logger';
  import { normalizeTagSuggestionOptions, TagInputSuggest } from '../../utils/tag-suggest';

  type DataSource = 'bookshelf' | 'epub-highlights';
  type TagSuggestionOption = string | { name: string; count?: number };

  interface Props {
    value?: string;
    placeholder?: string;
    onSearch?: (query: string) => void;
    onClear?: () => void;
    app: App;
    dataSource?: DataSource;
    availableTags?: TagSuggestionOption[];
    availableSources?: string[];
    availableStatuses?: string[];
    availableAuthors?: string[];
    availablePublishers?: string[];
    availableFormats?: string[];
    availableCommentStates?: string[];
    availableNoteTypes?: string[];
    availableHighlightColors?: string[];
    availableChapters?: string[];
    matchCount?: number;
    totalCount?: number;
    autoFocus?: boolean;
  }

  let { 
    value = $bindable(''),
    placeholder = '',
    onSearch,
    onClear,
    app,
    dataSource = 'bookshelf',
    availableTags = [],
    availableSources = [],
    availableStatuses = [],
    availableAuthors = [],
    availablePublishers = [],
    availableFormats = [],
    availableCommentStates = [],
    availableNoteTypes = [],
    availableHighlightColors = [],
    availableChapters = [],
    matchCount = -1,
    totalCount = -1,
    autoFocus = false
  }: Props = $props();
  let inputRef: HTMLInputElement | null = $state(null);
  let containerRef: HTMLDivElement | null = $state(null);
  let searchHistory = $state<string[]>([]);
  let menuShown = $state(false);
  let showDropdown = $state(false);
  let anchorWidth = $state(0);
  let activeMenu: Menu | null = null;
  let tagSuggest: TagInputSuggest | null = null;
  const usesUnifiedSearchShell = true;

  const normalizedAvailableTags = $derived.by(() => {
    return normalizeTagSuggestionOptions(availableTags || []);
  });

  let bookshelfSearchOptions = $derived.by(() => [
    { prefix: 'status:', label: 'status: 匹配阅读状态', afterInsert: () => showBookshelfStatusSuggestions() },
    { prefix: 'author:', label: 'author: 搜索作者', afterInsert: () => showAuthorSuggestions() },
    { prefix: 'publisher:', label: 'publisher: 搜索出版社', afterInsert: () => showPublisherSuggestions() },
    { prefix: 'format:', label: 'format: 搜索书籍格式', afterInsert: () => showFormatSuggestions() },
    { prefix: 'created:', label: 'created: 加入时间筛选', afterInsert: () => showDateSuggestions('created') },
  ]);

  let epubHighlightSearchOptions = $derived.by(() => [
    { prefix: 'tag:', label: 'tag: 搜索标签', afterInsert: () => showTagSuggestions() },
    { prefix: 'source:', label: 'source: 搜索来源文件', afterInsert: () => showSourceSuggestions() },
    { prefix: 'comment:', label: 'comment: 筛选是否含想法', afterInsert: () => showCommentSuggestions() },
    { prefix: 'type:', label: 'type: 搜索笔记类型', afterInsert: () => showNoteTypeSuggestions() },
    { prefix: 'color:', label: 'color: 搜索笔记颜色', afterInsert: () => showHighlightColorSuggestions() },
    { prefix: 'chapter:', label: 'chapter: 按章节筛选', afterInsert: () => showChapterSuggestions() },
    { prefix: 'created:', label: 'created: 创建日期筛选', afterInsert: () => showDateSuggestions('created') },
  ]);

  const dataSourceOptions = $derived.by(() =>
    dataSource === 'bookshelf' ? [...bookshelfSearchOptions] : [...epubHighlightSearchOptions]
  );

  function handleInputFocus() {
    updateAnchorWidth();
    showDropdown = true;
  }

  function updateAnchorWidth() {
    anchorWidth = containerRef?.getBoundingClientRect().width ?? 0;
  }

  function getDropdownStyle(): string {
    const width = Math.max(220, Math.round(anchorWidth || 0));
    return `width:min(${width}px, calc(100vw - 16px));`;
  }

  function handleDropdownClose() {
    commitSearchHistory(value);
    showDropdown = false;
    closeActiveMenu();
  }

  function handleSearchHistorySelect(historyItem: string, e: MouseEvent) {
    e.preventDefault();
    value = historyItem;
    onSearch?.(value);
    handleDropdownClose();
  }

  function clearAllHistory(e: MouseEvent) {
    e.preventDefault();
    searchHistory = [];
    saveSearchHistory();
  }

  onMount(() => {
    try {
      const saved = vaultStorage.getItem(`weave-search-history-${dataSource}`);
      if (saved) {
        searchHistory = JSON.parse(saved);
      }
    } catch (error) {
      logger.error('加载搜索历史失败:', error);
    }

    if (autoFocus) {
      window.setTimeout(() => {
        inputRef?.focus();
      }, 0);
    }

    return () => {
      showDropdown = false;
      closeActiveMenu();
    };
  });

  $effect(() => {
    if (!containerRef) return;

    const resizeObserver = new ResizeObserver(() => {
      updateAnchorWidth();
    });
    updateAnchorWidth();
    resizeObserver.observe(containerRef);

    return () => {
      resizeObserver.disconnect();
    };
  });

  // 保存搜索历史
  function saveSearchHistory() {
    try {
      vaultStorage.setItem(`weave-search-history-${dataSource}`, JSON.stringify(searchHistory));
    } catch (error) {
      logger.error('保存搜索历史失败:', error);
    }
  }

  // 添加到搜索历史
  function commitSearchHistory(query: string) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;

    searchHistory = searchHistory.filter(item => item !== normalizedQuery);
    searchHistory.unshift(normalizedQuery);
    if (searchHistory.length > 20) {
      searchHistory = searchHistory.slice(0, 20);
    }

    saveSearchHistory();
  }

  // 处理输入
  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    value = target.value;
    onSearch?.(value);
    
    // 检测是否输入了搜索前缀
    checkAndShowSuggestions();
  }

  function getCurrentSearchToken(): string {
    if (!inputRef) return '';

    const cursorPos = inputRef.selectionStart || 0;
    const textBeforeCursor = value.slice(0, cursorPos);
    const words = textBeforeCursor.split(/\s+/);
    return words[words.length - 1] ?? '';
  }

  function getSuggestionQuery(prefix: string): string {
    const token = getCurrentSearchToken();
    if (!token.toLowerCase().startsWith(prefix)) {
      return '';
    }

    return token
      .slice(prefix.length)
      .trim()
      .replace(/^['"]+/, '')
      .replace(/['"]+$/, '');
  }

  function checkAndShowSuggestions() {
    const lastWord = getCurrentSearchToken();
    const normalizedWord = lastWord.toLowerCase();

    if (normalizedWord.startsWith('tag:')) {
      closeActiveMenu();
    } else if (lastWord.endsWith('type:') && dataSource === 'epub-highlights') {
      showNoteTypeSuggestions();
    } else if (lastWord.endsWith('source:')) {
      showSourceSuggestions();
    } else if (lastWord.endsWith('status:') && dataSource === 'bookshelf') {
      showBookshelfStatusSuggestions();
    } else if (lastWord.endsWith('author:')) {
      showAuthorSuggestions();
    } else if (lastWord.endsWith('publisher:')) {
      showPublisherSuggestions();
    } else if (lastWord.endsWith('format:')) {
      showFormatSuggestions();
    } else if (lastWord.endsWith('comment:')) {
      showCommentSuggestions();
    } else if (lastWord.endsWith('color:')) {
      showHighlightColorSuggestions();
    } else if (lastWord.endsWith('chapter:') && dataSource === 'epub-highlights') {
      showChapterSuggestions();
    } else if (lastWord.endsWith('created:')) {
      showDateSuggestions('created');
    } else {
      closeActiveMenu();
    }
  }

  function closeActiveMenu() {
    if (!activeMenu) return;

    const menu = activeMenu;
    activeMenu = null;
    menuShown = false;
    menu.hide();
    menu.close();
  }

  function showMenuSafe(menu: Menu) {
    if (!containerRef) return;
    closeActiveMenu();
    activeMenu = menu;
    menuShown = true;
    const rect = containerRef.getBoundingClientRect();
    menu.onHide(() => {
      if (activeMenu === menu) {
        activeMenu = null;
        menuShown = false;
      }
    });
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
  }

  function showBookshelfStatusSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('阅读状态');
      item.setDisabled(true);
    });
    const values = availableStatuses.length > 0 ? availableStatuses : ['未开始', '阅读中', '已读完'];
    values.forEach((v) => {
      menu.addItem((item) => {
        item.setTitle(v);
        item.onClick(() => {
          replaceLastWord(v);
        });
      });
    });
    showMenuSafe(menu);
  }

  function showAuthorSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('作者');
      item.setDisabled(true);
    });
    if (availableAuthors.length === 0) {
      menu.addItem((item) => {
        item.setTitle('暂无作者');
        item.setDisabled(true);
      });
    } else {
      availableAuthors.slice(0, 20).forEach((author) => {
        menu.addItem((item) => {
          item.setTitle(author);
          item.onClick(() => {
            replaceLastWord(`"${author}"`);
          });
        });
      });
    }
    showMenuSafe(menu);
  }

  function showPublisherSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('出版社');
      item.setDisabled(true);
    });
    if (availablePublishers.length === 0) {
      menu.addItem((item) => {
        item.setTitle('暂无出版社');
        item.setDisabled(true);
      });
    } else {
      availablePublishers.slice(0, 20).forEach((publisher) => {
        menu.addItem((item) => {
          item.setTitle(publisher);
          item.onClick(() => {
            replaceLastWord(`"${publisher}"`);
          });
        });
      });
    }
    showMenuSafe(menu);
  }

  function showFormatSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('书籍格式');
      item.setDisabled(true);
    });
    if (availableFormats.length === 0) {
      menu.addItem((item) => {
        item.setTitle('暂无格式');
        item.setDisabled(true);
      });
    } else {
      availableFormats.slice(0, 20).forEach((format) => {
        menu.addItem((item) => {
          item.setTitle(format);
          item.onClick(() => {
            replaceLastWord(format);
          });
        });
      });
    }
    showMenuSafe(menu);
  }

  function showCommentSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('想法状态');
      item.setDisabled(true);
    });
    const values = availableCommentStates.length > 0
      ? availableCommentStates
      : ['有想法', '无想法'];
    values.forEach((value) => {
      menu.addItem((item) => {
        item.setTitle(value);
        item.onClick(() => {
          replaceLastWord(`"${value}"`);
        });
      });
    });
    showMenuSafe(menu);
  }

  function showNoteTypeSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('笔记类型');
      item.setDisabled(true);
    });
    const values = availableNoteTypes.length > 0 ? availableNoteTypes : ['高亮', '下划线', '删除线', '波浪线'];
    values.forEach((value) => {
      menu.addItem((item) => {
        item.setTitle(value);
        item.onClick(() => {
          replaceLastWord(`"${value}"`);
        });
      });
    });
    showMenuSafe(menu);
  }

  function showHighlightColorSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('笔记颜色');
      item.setDisabled(true);
    });
    const values = availableHighlightColors.length > 0 ? availableHighlightColors : ['黄色', '绿色', '蓝色', '红色', '紫色'];
    values.forEach((value) => {
      menu.addItem((item) => {
        item.setTitle(value);
        item.onClick(() => {
          replaceLastWord(`"${value}"`);
        });
      });
    });
    showMenuSafe(menu);
  }

  function showChapterSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('章节');
      item.setDisabled(true);
    });
    menu.addItem((item) => {
      item.setTitle('当前章节');
      item.onClick(() => {
        replaceLastWord('@current');
      });
    });
    if (availableChapters.length === 0) {
      menu.addItem((item) => {
        item.setTitle('暂无章节信息');
        item.setDisabled(true);
      });
    } else {
      availableChapters.slice(0, 20).forEach((chapter) => {
        menu.addItem((item) => {
          item.setTitle(chapter);
          item.onClick(() => {
            replaceLastWord(`"${chapter}"`);
          });
        });
      });
    }
    showMenuSafe(menu);
  }

  function showDateSuggestions(dateType: 'created' | 'modified' | 'due') {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;

    const titleMap = {
      created: dataSource === 'bookshelf' ? '加入时间筛选' : '创建日期筛选',
      modified: '修改日期筛选',
      due: '复习到期日筛选'
    };
    menu.addItem((item) => {
      item.setTitle(titleMap[dateType]);
      item.setDisabled(true);
    });

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const thisMonthStr = todayStr.slice(0, 7);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
    const thisYearStart = `${now.getFullYear()}-01-01`;

    const presets = dateType === 'due'
      ? [
          { label: `今天到期 (${todayStr})`, value: todayStr },
          { label: '已逾期', value: `<${todayStr}` },
          { label: '本周内到期', value: `${todayStr}..${new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10)}` },
          { label: `本月到期 (${thisMonthStr})`, value: thisMonthStr },
        ]
      : [
          { label: `今天 (${todayStr})`, value: todayStr },
          { label: `本月 (${thisMonthStr})`, value: thisMonthStr },
          { label: `上月 (${lastMonthStr})`, value: lastMonthStr },
          { label: `今年以来`, value: `>${thisYearStart}` },
          { label: '起止范围 (YYYY-MM-DD..YYYY-MM-DD)', value: `${thisYearStart}..${todayStr}` },
        ];
    presets.forEach(({ label, value: v }) => {
      menu.addItem((item) => {
        item.setTitle(label);
        item.onClick(() => { replaceLastWord(v); });
      });
    });
    showMenuSafe(menu);
  }

  // 显示标签建议
  function showTagSuggestions() {
    closeActiveMenu();
    inputRef?.focus();
    inputRef?.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 显示来源建议
  function showSourceSuggestions() {
    if (!containerRef || menuShown) return;
    const menu = new Menu();
    (menu as any).app = app;
    menu.addItem((item) => {
      item.setTitle('来源文档');
      item.setDisabled(true);
    });
    if (availableSources.length === 0) {
      menu.addItem((item) => {
        item.setTitle('暂无来源文档');
        item.setDisabled(true);
      });
    } else {
      availableSources.slice(0, 20).forEach((source) => {
        const fileName = source.split('/').pop() || source;
        menu.addItem((item) => {
          item.setTitle(fileName);
          item.onClick(() => {
            replaceLastWord(`"${source}"`);
          });
        });
      });
    }
    showMenuSafe(menu);
  }

  // 替换最后一个词
  function replaceLastWord(replacement: string) {
    if (!inputRef) return;
    
    const cursorPos = inputRef.selectionStart || 0;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    
    const words = textBeforeCursor.split(/\s+/);
    words[words.length - 1] = words[words.length - 1].replace(/[^:]*$/, replacement);
    
    const joined = words.join(' ') + ' ';
    const trimmedAfter = textAfterCursor.trimStart();
    const newValue = joined + trimmedAfter;
    const newCursorPos = joined.length;
    
    value = newValue;
    
    window.setTimeout(() => {
      if (inputRef) {
        inputRef.focus();
        inputRef.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
    
    onSearch?.(value);
  }

  // 清除搜索
  function handleClear() {
    closeActiveMenu();
    value = '';
    onClear?.();
    onSearch?.('');
    inputRef?.focus();
  }

  // 插入前缀到搜索框
  function insertPrefix(prefix: string) {
    if (!inputRef) return;
    
    // 如果搜索框为空或以空格结尾，直接添加
    if (!value || value.endsWith(' ')) {
      value = value + prefix;
    } else {
      // 否则先加空格再添加
      value = value + ' ' + prefix;
    }
    
    // 聚焦并将光标移到末尾
    window.setTimeout(() => {
      if (inputRef) {
        inputRef.focus();
        inputRef.setSelectionRange(value.length, value.length);
      }
    }, 0);
    
    onSearch?.(value);
  }

  // 处理回车
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      commitSearchHistory(value);
      handleDropdownClose();
    } else if (e.key === 'Escape') {
      handleDropdownClose();
      inputRef?.blur();
    } else if (e.key === ':') {
      // 输入冒号后延迟检查
      window.setTimeout(() => {
        checkAndShowSuggestions();
      }, 50);
    }
  }

  $effect(() => {
    if (!inputRef) {
      tagSuggest?.destroy();
      tagSuggest = null;
      return;
    }

    const suggest = new TagInputSuggest(app, inputRef, {
      getItems: () => normalizedAvailableTags,
      getQuery: () => getSuggestionQuery('tag:'),
      isActive: () => getCurrentSearchToken().toLowerCase().startsWith('tag:'),
      onSelectTag: (tag) => replaceLastWord(tag),
      limit: 40,
    });

    tagSuggest = suggest;

    return () => {
      suggest.destroy();
      if (tagSuggest === suggest) {
        tagSuggest = null;
      }
    };
  });
</script>

<div class="card-search-container" bind:this={containerRef}>
  <div class="search-input-wrapper" class:is-unified-shell={usesUnifiedSearchShell}>
    <div class="search-icon">
      <EnhancedIcon name={ICON_NAMES.SEARCH} size={16} />
    </div>
    
    <input
      bind:this={inputRef}
      type="text"
      class="search-input"
      {placeholder}
      value={value}
      oninput={handleInput}
      onkeydown={handleKeydown}
      onfocus={handleInputFocus}
    />
    
    {#if value && matchCount >= 0}
      <span class="match-count">{matchCount}{totalCount >= 0 ? `/${totalCount}` : ''}</span>
    {/if}

    {#if value}
      <div
        class="clear-button"
        role="button"
        tabindex="-1"
        onclick={handleClear}
        onkeydown={(e) => { if (e.key === 'Enter') handleClear(); }}
        aria-label={'清除搜索'}
      >
        <EnhancedIcon name={ICON_NAMES.TIMES} size={14} />
      </div>
    {/if}

  </div>

  <FloatingMenu
    show={showDropdown}
    anchor={containerRef}
    placement="bottom-start"
    offset={4}
    onClose={handleDropdownClose}
    class="card-search-floating-menu"
  >
    {#snippet children()}
      <div class="search-dropdown" style={getDropdownStyle()}>
        <div class="dropdown-section">
          <div class="dropdown-section-header">{'搜索选项'}</div>
          {#each dataSourceOptions as opt}
            <div
              class="dropdown-item"
              role="button"
              tabindex="-1"
              onmousedown={(e) => {
                e.preventDefault();
                insertPrefix(opt.prefix);
                showDropdown = false;
                if (opt.afterInsert) window.setTimeout(opt.afterInsert, 100);
              }}
            >
              <span class="dropdown-item-label">{opt.label}</span>
            </div>
          {/each}
        </div>

        {#if searchHistory.length > 0}
          <div class="dropdown-divider"></div>
          <div class="dropdown-section">
            <div class="dropdown-section-header">
              <span>{'搜索历史'}</span>
              <span
                class="dropdown-clear-all"
                role="button"
                tabindex="-1"
                onmousedown={clearAllHistory}
                aria-label={'清空搜索历史'}
                title={'清空搜索历史'}
              >
                <EnhancedIcon name={ICON_NAMES.TIMES} size={12} />
              </span>
            </div>
            {#each searchHistory.slice(0, 10) as historyItem}
              <div
                class="dropdown-item dropdown-item-history"
                role="button"
                tabindex="-1"
                onmousedown={(e) => handleSearchHistorySelect(historyItem, e)}
              >
                <span class="dropdown-item-label">{historyItem}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}
  </FloatingMenu>
</div>

<style>
  .card-search-container {
    position: relative;
    width: 100%;
  }

  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    padding: 0 8px;
    transition: all 0.2s ease;
    z-index: 1;
  }

  .search-input-wrapper:focus-within {
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px var(--background-modifier-border-focus);
  }

  .search-input-wrapper.is-unified-shell:focus-within {
    box-shadow: none;
  }

  .search-input-wrapper.is-unified-shell .search-input,
  .search-input-wrapper.is-unified-shell .search-input[type="text"],
  .search-input-wrapper.is-unified-shell .search-input[type="text"]:hover,
  .search-input-wrapper.is-unified-shell .search-input[type="text"]:focus,
  .search-input-wrapper.is-unified-shell .search-input[type="text"]:focus-visible,
  .search-input-wrapper.is-unified-shell .search-input[type="text"]:active {
    appearance: none;
    -webkit-appearance: none;
    border: none !important;
    background: transparent !important;
    background-color: transparent !important;
    box-shadow: none !important;
    outline: none !important;
    border-radius: 0 !important;
  }

  .search-icon {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    margin-right: 8px;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    padding: 8px 4px;
    font-size: 14px;
    color: var(--text-normal);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-faint);
  }

  .match-count {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
    padding: 0 4px;
  }

  .clear-button {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .clear-button:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .search-dropdown {
    background: var(--modal-background, var(--background-primary));
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    box-shadow: var(--shadow-l, 0 8px 24px rgba(0, 0, 0, 0.16));
    max-width: calc(100vw - 16px);
    max-height: min(360px, calc(100vh - 16px));
    overflow-y: auto;
    animation: dropdownFadeIn 0.15s ease;
  }

  :global(body > .floating-menu.card-search-floating-menu) {
    min-width: 0;
    max-width: none;
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    overflow: visible;
    animation: none;
    z-index: var(--weave-z-dropdown, 1600);
  }

  @keyframes dropdownFadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .dropdown-section {
    padding: 4px 0;
  }

  .dropdown-section-header {
    padding: 8px 12px 6px;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-normal);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .dropdown-clear-all {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: 4px;
  }

  .dropdown-clear-all:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
  }

  .dropdown-divider {
    height: 1px;
    background: var(--background-modifier-border);
    margin: 2px 8px;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 12px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-normal);
    font-size: 0.8125rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s ease;
    gap: 8px;
    box-shadow: none;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  .dropdown-item-history {
    padding-top: 7px;
    padding-bottom: 7px;
  }

  .dropdown-item:hover {
    background: var(--background-modifier-hover);
  }

  .dropdown-item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

</style>
