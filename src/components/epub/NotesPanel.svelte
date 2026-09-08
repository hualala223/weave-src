<script lang="ts">
	import { onMount } from 'svelte';
	import type { App } from 'obsidian';
	import { Menu, Notice, Platform, setIcon } from 'obsidian';
	import { showObsidianConfirm } from '../../utils/obsidian-confirm';
	import { logger } from '../../utils/logger';
	import { parseSearchQuery, type DateRange, type SearchQuery } from '../../utils/search-parser';
	import {
		selectTodayExcerpts,
		selectUnpastedExcerpts,
	} from '../../services/epub/excerpt-selection';
	import { sortExcerptsForDisplay } from '../../services/epub/excerpt-display-order';
	import type { EpubBook, EpubHighlightViewSnapshotService, EpubReaderEngine } from '../../services/epub';
	import {
		buildEpubDisplayHighlightSelectionKey,
		type EpubDisplayHighlight,
		type EpubHighlightRenderSnapshot,
	} from '../../services/epub/EpubHighlightViewSnapshotService';
	import EpubAnnotationCard from './EpubAnnotationCard.svelte';
	import EpubLoadingState from './EpubLoadingState.svelte';

	interface HighlightSearchMeta {
		availableTags: string[];
		availableSources: string[];
		availableCommentStates: string[];
		availableNoteTypes: string[];
		availableHighlightColors: string[];
		availableChapters: string[];
		matchCount: number;
		totalCount: number;
	}

	interface Props {
		app: App;
		book: EpubBook | null;
		readerService?: EpubReaderEngine | null;
		snapshotService?: EpubHighlightViewSnapshotService | null;
		filePath?: string;
		highlightRevision?: number;
		showStrikethroughHighlights?: boolean;
		newestExcerptOnTop?: boolean;
		currentChapterTitle?: string;
		currentChapterIndex?: number;
		onDeleteHighlight?: (highlight: EpubDisplayHighlight) => Promise<boolean>;
		onPasteHighlights?: (highlights: EpubDisplayHighlight[]) => Promise<boolean>;
		searchQuery?: string;
		searchMeta?: HighlightSearchMeta;
		onNavigate?: (
			cfi: string,
			text?: string,
			color?: string,
			metadata?: {
				sourceFile?: string;
				sourceRef?: string;
				createdTime?: number;
			}
		) => void;
	}

	let {
		app,
		book,
		readerService = null,
		snapshotService = null,
		filePath,
		highlightRevision = 0,
		showStrikethroughHighlights = false,
		newestExcerptOnTop = true,
		currentChapterTitle = '',
		currentChapterIndex = -1,
		onDeleteHighlight,
		onPasteHighlights,
		searchQuery = $bindable(''),
		searchMeta = $bindable<HighlightSearchMeta>({
			availableTags: [],
			availableSources: [],
			availableCommentStates: [],
			availableNoteTypes: [],
			availableHighlightColors: [],
			availableChapters: [],
			matchCount: 0,
			totalCount: 0,
		}),
		onNavigate,
	}: Props = $props();
	function iconAction(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				node.replaceChildren();
				setIcon(node, newName);
			},
		};
	}

	let highlights = $state<EpubDisplayHighlight[]>([]);
	let preparing = $state(false);
	let syncing = $state(false);
	let selectionMode = $state(false);
	let selectedKeys = $state<Set<string>>(new Set());
	let batchDeleting = $state(false);
	let pasting = $state(false);
	let annotationLoadToken = 0;
	let panelDisposed = false;
	let lastLoadContextKey = '';
	// 移动端没有可靠的右键（contextmenu 长按触发因平台而异），
	// 面板级操作需要显式按钮入口（与桌面右键共用同一套菜单项）。
	const isMobilePanel = Platform.isMobile || document.body.classList.contains('is-mobile');

	function normalizeSearchText(value: string | undefined): string {
		return typeof value === 'string' ? value.trim().toLowerCase() : '';
	}

	function buildUniqueSortedValues(values: Array<string | undefined>): string[] {
		return Array.from(new Set(values.map((value) => value?.trim() || '').filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
	}

	function matchesSearchTermList(values: string[], terms: string[]): boolean {
		if (terms.length === 0) {
			return true;
		}

		return terms.every((term) => {
			const normalizedTerm = normalizeSearchText(term);
			if (!normalizedTerm) {
				return true;
			}
			return values.some((value) => normalizeSearchText(value).includes(normalizedTerm));
		});
	}

	function matchesExcludedSearchTerms(values: string[], terms: string[]): boolean {
		if (terms.length === 0) {
			return true;
		}

		return terms.every((term) => {
			const normalizedTerm = normalizeSearchText(term);
			if (!normalizedTerm) {
				return true;
			}
			return values.every((value) => !normalizeSearchText(value).includes(normalizedTerm));
		});
	}

	function matchesFieldValues(target: string | undefined, values: string[]): boolean {
		if (values.length === 0) {
			return true;
		}

		const normalizedTarget = normalizeSearchText(target);
		if (!normalizedTarget) {
			return false;
		}

		return values.some((value) => {
			const normalizedValue = normalizeSearchText(value);
			return normalizedValue ? normalizedTarget.includes(normalizedValue) : false;
		});
	}

	function matchesArrayFieldValues(targets: string[], values: string[]): boolean {
		if (values.length === 0) {
			return true;
		}

		return values.some((value) => {
			const normalizedValue = normalizeSearchText(value);
			if (!normalizedValue) {
				return false;
			}

			return targets.some((target) => normalizeSearchText(target).includes(normalizedValue));
		});
	}

	function parseDateBoundary(value: string, boundary: 'start' | 'end'): number | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			return null;
		}

		const timestamp = new Date(boundary === 'start' ? `${value}T00:00:00.000` : `${value}T23:59:59.999`).getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	function matchesDateRange(timestamp: number, range: DateRange): boolean {
		if (!Number.isFinite(timestamp) || timestamp <= 0) {
			return false;
		}

		const from = range.from ? parseDateBoundary(range.from, 'start') : null;
		if (range.from && from === null) {
			return false;
		}

		const to = range.to ? parseDateBoundary(range.to, 'end') : null;
		if (range.to && to === null) {
			return false;
		}

		if (from !== null && timestamp < from) {
			return false;
		}

		if (to !== null && timestamp > to) {
			return false;
		}

		return true;
	}

	function matchesDateRanges(timestamp: number, ranges: DateRange[]): boolean {
		if (ranges.length === 0) {
			return true;
		}

		return ranges.some((range) => matchesDateRange(timestamp, range));
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

	function getSourceLabel(sourceFile?: string): string {
		if (!sourceFile || sourceFile === '__inline__') {
			return '';
		}
		const normalized = sourceFile.replace(/\\/g, '/');
		const basename = normalized.split('/').pop() || normalized;
		const displayName = basename.replace(/\.[^.]+$/, '');
		return displayName ? `- 《${displayName}》` : '';
	}

	function getEmptyExcerptHint(text?: string): string {
		return String(text || '').trim() ? '' : '摘录内容为空';
	}

	function navigateToHighlight(hl: EpubDisplayHighlight) {
		if (hl.cfiRange) {
			onNavigate?.(hl.cfiRange, hl.text, hl.color, {
				sourceFile: hl.sourceFile,
				sourceRef: hl.sourceRef,
				createdTime: hl.createdTime,
			});
		}
	}

	function getHighlightSelectionKey(highlight: EpubDisplayHighlight): string {
		return buildEpubDisplayHighlightSelectionKey(highlight);
	}

	function getHighlightChapterLabel(highlight: EpubDisplayHighlight): string {
		const chapterTitle = String(highlight.chapterTitle || '').trim();
		if (chapterTitle) {
			return chapterTitle;
		}
		if (typeof highlight.chapterIndex === 'number' && highlight.chapterIndex >= 0) {
			return `第 ${highlight.chapterIndex + 1} 章`;
		}
		return '';
	}

	function matchesChapterValues(
		highlight: EpubDisplayHighlight,
		values: string[],
		currentTitle: string,
		currentIndex: number
	): boolean {
		if (values.length === 0) {
			return true;
		}

		const chapterLabel = getHighlightChapterLabel(highlight);
		const normalizedChapterLabel = normalizeSearchText(chapterLabel);
		const normalizedPageLabel = normalizeSearchText(highlight.pageLabel);

		return values.some((value) => {
			const normalizedValue = normalizeSearchText(value);
			if (!normalizedValue) {
				return false;
			}

			if (['@current', 'current', '当前', '当前章节', '当前章'].includes(normalizedValue)) {
				if (currentIndex >= 0 && typeof highlight.chapterIndex === 'number') {
					return highlight.chapterIndex === currentIndex;
				}
				const normalizedCurrentTitle = normalizeSearchText(currentTitle);
				return Boolean(
					normalizedCurrentTitle &&
					(normalizedChapterLabel.includes(normalizedCurrentTitle) ||
						normalizedCurrentTitle.includes(normalizedChapterLabel))
				);
			}

			if (/^\d+$/.test(normalizedValue)) {
				const chapterNumber = Number.parseInt(normalizedValue, 10);
				if (Number.isFinite(chapterNumber) && typeof highlight.chapterIndex === 'number') {
					return highlight.chapterIndex + 1 === chapterNumber;
				}
			}

			return (
				normalizedChapterLabel.includes(normalizedValue) ||
				normalizedPageLabel.includes(normalizedValue)
			);
		});
	}

	function matchesCommentValues(highlight: EpubDisplayHighlight, values: string[]): boolean {
		if (values.length === 0) {
			return true;
		}

		return values.some((value) => {
			const normalizedValue = normalizeSearchText(value);
			if (!normalizedValue) {
				return false;
			}

			if ([
				'有想法'.toLowerCase(),
				'有批注',
				'有想法',
				'有',
				'true',
				'yes',
				'1',
				'commented',
			].includes(normalizedValue)) {
				return highlight.hasCommentDivider;
			}

			if ([
				'无想法'.toLowerCase(),
				'无批注',
				'无想法',
				'无',
				'false',
				'no',
				'0',
				'none',
			].includes(normalizedValue)) {
				return !highlight.hasCommentDivider;
			}

			return highlight.commentStateLabel.toLowerCase().includes(normalizedValue);
		});
	}

	function matchesHighlightQuery(highlight: EpubDisplayHighlight, query: SearchQuery): boolean {
		if (!query.raw.trim()) {
			return true;
		}

		const noteTypeSearchTarget = `${highlight.noteType} ${highlight.noteTypeKey}`;
		const colorSearchTarget = `${highlight.colorLabel} ${highlight.color}`;

		return matchesSearchTermList(highlight.searchableValues, query.text)
			&& matchesExcludedSearchTerms(highlight.searchableValues, query.excludeText)
			&& matchesArrayFieldValues(highlight.tags, query.tags)
			&& matchesFieldValues(highlight.sourceFile, query.sources)
			&& matchesCommentValues(highlight, query.comments)
			&& matchesFieldValues(noteTypeSearchTarget, query.types)
			&& matchesFieldValues(colorSearchTarget, query.colors)
			&& matchesChapterValues(highlight, query.chapters, currentChapterTitle, currentChapterIndex)
			&& matchesDateRanges(highlight.createdTime, query.dateRanges);
	}

	let parsedHighlightSearchQuery = $derived.by(() => parseSearchQuery(searchQuery));

	let annotationListView = $derived.by(() => {
		const parsed = parsedHighlightSearchQuery;
		// 排序方向由「最新摘录在最上」设置驱动（显示层排序，不回写快照，侧栏不受影响）。
		const filtered = sortExcerptsForDisplay(
			highlights.filter((highlight) => matchesHighlightQuery(highlight, parsed)),
			newestExcerptOnTop
		);
		return {
			filtered,
			availableTags: buildUniqueSortedValues(highlights.flatMap((highlight) => highlight.tags)),
			availableSources: buildUniqueSortedValues(highlights.map((highlight) => highlight.sourceFile)),
			availableCommentStates: buildUniqueSortedValues(
				highlights.map((highlight) => highlight.commentStateLabel)
			),
			availableNoteTypes: buildUniqueSortedValues(highlights.map((highlight) => highlight.noteType)),
			availableHighlightColors: buildUniqueSortedValues(
				highlights.map((highlight) => highlight.colorLabel)
			),
			availableChapters: buildUniqueSortedValues(
				highlights.map((highlight) => getHighlightChapterLabel(highlight))
			),
		};
	});

	let filteredHighlights = $derived(annotationListView.filtered);

	let availableTagOptions = $derived(annotationListView.availableTags);
	let availableSourceOptions = $derived(annotationListView.availableSources);
	let availableCommentStateOptions = $derived(annotationListView.availableCommentStates);
	let availableNoteTypeOptions = $derived(annotationListView.availableNoteTypes);
	let availableHighlightColorOptions = $derived(annotationListView.availableHighlightColors);
	let availableChapterOptions = $derived(annotationListView.availableChapters);

	// 所选集合基于本书全部摘录（而非当前筛选结果）：「选中今日摘录/未粘贴摘录」
	// 圈定的候选不受搜索筛选影响，勾选后改变筛选也不丢已选（票03/04 全书口径）。
	let selectedHighlights = $derived.by(() =>
		highlights.filter((highlight) => selectedKeys.has(getHighlightSelectionKey(highlight)))
	);

	let selectionCountLabel = $derived(
		`已选 ${selectedHighlights.length} / ${filteredHighlights.length}`
	);

	$effect(() => {
		searchMeta = {
			availableTags: availableTagOptions,
			availableSources: availableSourceOptions,
			availableCommentStates: availableCommentStateOptions,
			availableNoteTypes: availableNoteTypeOptions,
			availableHighlightColors: availableHighlightColorOptions,
			availableChapters: availableChapterOptions,
			matchCount: filteredHighlights.length,
			totalCount: highlights.length,
		};
	});

	function exitSelectionMode() {
		selectionMode = false;
		selectedKeys = new Set();
	}

	function enterSelectionMode(seedHighlight?: EpubDisplayHighlight) {
		selectionMode = true;
		if (seedHighlight) {
			const next = new Set(selectedKeys);
			next.add(getHighlightSelectionKey(seedHighlight));
			selectedKeys = next;
		}
	}

	function toggleHighlightSelection(highlight: EpubDisplayHighlight) {
		const key = getHighlightSelectionKey(highlight);
		const next = new Set(selectedKeys);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		selectedKeys = next;
	}

	function selectAllFilteredHighlights() {
		selectedKeys = new Set(filteredHighlights.map((highlight) => getHighlightSelectionKey(highlight)));
	}

	function clearSelectedHighlights() {
		selectedKeys = new Set();
	}

	/**
	 * 快捷圈定（票04）：按条件**替换**当前选择集合（先清空再圈定），用户再手动剔除
	 * 不需要的条目后批量粘贴。圈定范围是本书全部摘录（不受面板搜索/筛选影响）；
	 * 无命中时清空选择并提示，避免界面无响应的错觉。
	 */
	function quickSelectHighlights(candidates: EpubDisplayHighlight[], emptyMessage: string) {
		selectedKeys = new Set(candidates.map((highlight) => getHighlightSelectionKey(highlight)));
		if (candidates.length === 0) {
			new Notice(emptyMessage);
		}
	}

	function selectTodayHighlights() {
		quickSelectHighlights(selectTodayExcerpts(highlights, Date.now()), '今天没有摘录');
	}

	function selectUnpastedHighlights() {
		quickSelectHighlights(selectUnpastedExcerpts(highlights), '没有未粘贴过的摘录');
	}

	function attachMenuApp(menu: Menu) {
		(menu as Menu & { app?: App }).app = app;
	}

	async function deleteHighlightItem(highlight: EpubDisplayHighlight, quiet = false): Promise<boolean> {
		if (!onDeleteHighlight) {
			if (!quiet) {
				new Notice('删除高亮失败');
			}
			return false;
		}
		return onDeleteHighlight(highlight);
	}

	async function deleteSelectedHighlights() {
		if (!onDeleteHighlight || selectedHighlights.length === 0 || batchDeleting) {
			return;
		}
		const confirmed = await showObsidianConfirm(
			app,
			`确定删除 ${selectedHighlights.length} 条摘录笔记？`,
			{
				title: '删除摘录笔记',
				confirmText: '删除所选摘录',
				cancelText: '取消',
				confirmClass: 'mod-warning',
			}
		);
		if (!confirmed) {
			return;
		}

		batchDeleting = true;
		let deletedCount = 0;
		try {
			for (const highlight of selectedHighlights) {
				const deleted = await deleteHighlightItem(highlight, true);
				if (deleted) {
					deletedCount += 1;
				}
			}
			if (deletedCount > 0) {
				new Notice(`已删除 ${deletedCount} 条摘录`);
			}
			if (deletedCount < selectedHighlights.length) {
				new Notice('部分摘录删除失败');
			}
			exitSelectionMode();
		} finally {
			batchDeleting = false;
		}
	}

	/**
	 * 把给定摘录按最早在前粘贴到打开的笔记文档（与划线自动粘贴同款格式）。
	 * 成功/失败提示由宿主（阅读器）弹出；批量路径粘贴后保持选择模式，便于继续勾选粘贴。
	 */
	async function pasteHighlights(highlights: EpubDisplayHighlight[]) {
		if (!onPasteHighlights || highlights.length === 0 || pasting) {
			return;
		}
		pasting = true;
		try {
			await onPasteHighlights(highlights);
		} finally {
			pasting = false;
		}
	}

	async function pasteSelectedHighlights() {
		await pasteHighlights(selectedHighlights);
	}

	/**
	 * 批量选择模式的菜单项集合（票01：卡片右键与面板空白右键共用同一套，
	 * 无论在列表什么位置右键，粘贴/删除等批量操作都可用）。
	 */
	function fillBatchSelectionMenuItems(menu: Menu) {
		menu.addItem((item) => {
			item.setTitle('粘贴所选摘录到笔记');
			item.setIcon('clipboard-paste');
			item.setDisabled(selectedHighlights.length === 0 || !onPasteHighlights || pasting);
			item.onClick(() => {
				void pasteSelectedHighlights();
			});
		});
		menu.addItem((item) => {
			item.setTitle('删除所选摘录');
			item.setIcon('trash');
			item.setDisabled(selectedHighlights.length === 0 || !onDeleteHighlight || batchDeleting);
			item.onClick(() => {
				void deleteSelectedHighlights();
			});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle('选中今日摘录');
			item.setIcon('calendar');
			item.onClick(() => {
				selectTodayHighlights();
			});
		});
		menu.addItem((item) => {
			item.setTitle('选中未粘贴摘录');
			item.setIcon('eye-off');
			item.onClick(() => {
				selectUnpastedHighlights();
			});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle('全选当前结果');
			item.setIcon('check-check');
			item.setDisabled(filteredHighlights.length === 0);
			item.onClick(() => {
				selectAllFilteredHighlights();
			});
		});
		menu.addItem((item) => {
			item.setTitle('取消全选');
			item.setIcon('ban');
			item.setDisabled(selectedHighlights.length === 0);
			item.onClick(() => {
				clearSelectedHighlights();
			});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle('退出批量选择');
			item.setIcon('x');
			item.onClick(() => {
				exitSelectionMode();
			});
		});
	}

	/** 面板级菜单项（批量模式=批量菜单；非批量=批量选择/粘贴全部）。 */
	function fillPanelMenuItems(menu: Menu) {
		if (selectionMode) {
			fillBatchSelectionMenuItems(menu);
		} else {
			menu.addItem((item) => {
				item.setTitle('批量选择');
				item.setIcon('check-square');
				item.onClick(() => {
					enterSelectionMode();
				});
			});
			menu.addItem((item) => {
				item.setTitle('粘贴全部摘录到笔记');
				item.setIcon('clipboard-paste');
				item.setDisabled(highlights.length === 0 || !onPasteHighlights || pasting);
				item.onClick(() => {
					void pasteHighlights(highlights);
				});
			});
		}
	}

	function openPanelMenu(event: MouseEvent) {
		const menu = new Menu();
		attachMenuApp(menu);
		fillPanelMenuItems(menu);
		menu.showAtMouseEvent(event);
	}

	/** 批量工具条「更多操作」按钮：弹出与右键一致的批量菜单（移动端无右键的主入口）。 */
	function openBatchMenu(event: MouseEvent) {
		const menu = new Menu();
		attachMenuApp(menu);
		fillBatchSelectionMenuItems(menu);
		menu.showAtMouseEvent(event);
	}

	function showPanelContextMenu(event: MouseEvent) {
		event.preventDefault();
		openPanelMenu(event);
	}

	function showHighlightContextMenu(event: MouseEvent, highlight: EpubDisplayHighlight) {
		event.preventDefault();
		event.stopPropagation();
		const menu = new Menu();
		attachMenuApp(menu);

		// 票01：批量模式下卡片右键 = 与面板空白一致的批量菜单（不再出现单条删除）。
		if (selectionMode) {
			fillBatchSelectionMenuItems(menu);
			menu.showAtMouseEvent(event);
			return;
		}

		menu.addItem((item) => {
			item.setTitle('批量选择');
			item.setIcon('check-square');
			item.onClick(() => {
				enterSelectionMode(highlight);
			});
		});
		menu.addItem((item) => {
			item.setTitle('粘贴到笔记');
			item.setIcon('clipboard-paste');
			item.setDisabled(!onPasteHighlights || pasting);
			item.onClick(() => {
				void pasteHighlights([highlight]);
			});
		});
		menu.addItem((item) => {
			item.setTitle('删除摘录');
			item.setIcon('trash');
			item.setDisabled(!onDeleteHighlight || batchDeleting);
			item.onClick(() => {
				void deleteHighlightItem(highlight);
			});
		});

		menu.showAtMouseEvent(event);
	}

	function handleHighlightActivate(highlight: EpubDisplayHighlight) {
		if (selectionMode) {
			toggleHighlightSelection(highlight);
			return;
		}
		navigateToHighlight(highlight);
	}

	function isStaleAnnotationsLoad(loadToken: number, expectedBookId: string, expectedFilePath?: string): boolean {
		return panelDisposed
			|| loadToken !== annotationLoadToken
			|| book?.id !== expectedBookId
			|| (filePath ?? '') !== (expectedFilePath ?? '');
	}

	function applySnapshot(nextHighlights: EpubDisplayHighlight[]) {
		highlights = nextHighlights;
	}

	async function hydratePageLabelsInBackground(
		loadToken: number,
		expectedBook: NonNullable<typeof book>,
		expectedFilePath: string | undefined,
		showStrikethrough: boolean
	) {
		if (!snapshotService) {
			return;
		}
		try {
			const hydratedSnapshot = await snapshotService.hydratePageLabels({
				bookId: expectedBook.id,
				filePath: expectedFilePath ?? '',
				showStrikethroughHighlights: showStrikethrough,
				readerService,
				highlightRevision,
			});
			if (!hydratedSnapshot || isStaleAnnotationsLoad(loadToken, expectedBook.id, expectedFilePath)) {
				return;
			}
			applySnapshot(hydratedSnapshot.highlights);
		} catch (error) {
			logger.error('[NotesPanel] Failed to hydrate page labels:', error);
		}
	}

	function shouldSkipBackgroundAnnotationRefresh(snapshot: EpubHighlightRenderSnapshot): boolean {
		return (
			snapshot.revision === highlightRevision &&
			snapshot.pageLabelsResolved
		);
	}

	async function refreshAnnotationsInBackground(
		loadToken: number,
		expectedBook: NonNullable<typeof book>,
		expectedFilePath: string | undefined,
		showStrikethrough: boolean
	) {
		if (!snapshotService) {
			return;
		}
		syncing = true;
		try {
			const freshSnapshot = await snapshotService.revalidateSnapshot({
				bookId: expectedBook.id,
				filePath: expectedFilePath ?? '',
				showStrikethroughHighlights: showStrikethrough,
				readerService,
				highlightRevision,
			});
			if (!freshSnapshot || isStaleAnnotationsLoad(loadToken, expectedBook.id, expectedFilePath)) {
				return;
			}
			applySnapshot(freshSnapshot.highlights);
			if (!freshSnapshot.pageLabelsResolved) {
				void hydratePageLabelsInBackground(
					loadToken,
					expectedBook,
					expectedFilePath,
					showStrikethrough
				);
			}
		} catch (error) {
			logger.error('[NotesPanel] Failed to refresh annotations:', error);
		} finally {
			if (!isStaleAnnotationsLoad(loadToken, expectedBook.id, expectedFilePath)) {
				syncing = false;
			}
		}
	}

	function buildSnapshotContext(
		currentBook: NonNullable<typeof book>,
		expectedFilePath: string | undefined
	) {
		return {
			bookId: currentBook.id,
			filePath: expectedFilePath ?? '',
			showStrikethroughHighlights,
		};
	}

	async function resolveDisplaySnapshot(
		currentBook: NonNullable<typeof book>,
		expectedFilePath: string | undefined
	) {
		const context = buildSnapshotContext(currentBook, expectedFilePath);
		const memorySnapshot = snapshotService?.getCachedSnapshot(context) || null;
		if (memorySnapshot) {
			return memorySnapshot;
		}
		if (!snapshotService) {
			return null;
		}
		return (await snapshotService.hydrateFromDisk(context)) || null;
	}

	async function loadAnnotations() {
		const currentBook = book;
		if (!currentBook) {
			highlights = [];
			preparing = false;
			syncing = false;
			return;
		}
		const expectedFilePath = filePath;
		const loadToken = ++annotationLoadToken;
		const snapshotContext = buildSnapshotContext(currentBook, expectedFilePath);
		const cachedSnapshot = await resolveDisplaySnapshot(currentBook, expectedFilePath);
		if (cachedSnapshot) {
			applySnapshot(cachedSnapshot.highlights);
			preparing = false;
			if (shouldSkipBackgroundAnnotationRefresh(cachedSnapshot)) {
				return;
			}
			if (!cachedSnapshot.pageLabelsResolved) {
				void hydratePageLabelsInBackground(
					loadToken,
					currentBook,
					expectedFilePath,
					showStrikethroughHighlights
				);
			}
			void refreshAnnotationsInBackground(
				loadToken,
				currentBook,
				expectedFilePath,
				showStrikethroughHighlights
			);
			return;
		}

		preparing = true;
		syncing = false;
		try {
			if (isStaleAnnotationsLoad(loadToken, currentBook.id, expectedFilePath)) {
				return;
			}
			const freshSnapshot = await resolveDisplaySnapshot(currentBook, expectedFilePath);
			if (freshSnapshot) {
				applySnapshot(freshSnapshot.highlights);
				if (!freshSnapshot.pageLabelsResolved && snapshotService) {
					void hydratePageLabelsInBackground(
						loadToken,
						currentBook,
						expectedFilePath,
						showStrikethroughHighlights
					);
				}
				return;
			}

			const revalidatedSnapshot = snapshotService
				? await snapshotService.revalidateSnapshot({
					...snapshotContext,
					readerService,
					highlightRevision,
				})
				: null;
			if (isStaleAnnotationsLoad(loadToken, currentBook.id, expectedFilePath)) {
				return;
			}
			if (revalidatedSnapshot) {
				applySnapshot(revalidatedSnapshot.highlights);
				if (!revalidatedSnapshot.pageLabelsResolved && snapshotService) {
					void hydratePageLabelsInBackground(
						loadToken,
						currentBook,
						expectedFilePath,
						showStrikethroughHighlights
					);
				}
			}
		} catch (error) {
			if (isStaleAnnotationsLoad(loadToken, currentBook.id, expectedFilePath)) {
				return;
			}
			logger.error('[NotesPanel] Failed to load annotations:', error);
			highlights = [];
		} finally {
			if (!isStaleAnnotationsLoad(loadToken, currentBook.id, expectedFilePath)) {
				preparing = false;
			}
		}
	}

	$effect(() => {
		const contextKey = [book?.id ?? '', filePath ?? '', String(highlightRevision), showStrikethroughHighlights ? '1' : '0'].join('::');
		if (book) {
			if (contextKey === lastLoadContextKey) {
				return;
			}
			lastLoadContextKey = contextKey;
			void loadAnnotations();
		} else {
			annotationLoadToken += 1;
			highlights = [];
			preparing = false;
			syncing = false;
			lastLoadContextKey = '';
		}
	});

	onMount(() => {
		return () => {
			panelDisposed = true;
			annotationLoadToken += 1;
		};
	});
</script>

<div
	class="epub-notes-panel"
	class:selection-mode={selectionMode}
	oncontextmenu={showPanelContextMenu}
>
	{#if preparing}
		<EpubLoadingState message={'正在准备摘录索引…'} surface />
	{:else if filteredHighlights.length === 0}
		<div class="epub-placeholder">
			{#if highlights.length === 0}
				{'暂时还没有摘录，阅读时选中文本后就可以在这里回看。'}
			{:else}
				{'没有匹配的摘录，请尝试调整 tag:、source:、comment:、type:、color: 或 chapter: 条件。'}
			{/if}
		</div>
	{:else}
		{#if isMobilePanel && !selectionMode}
			<div class="epub-notes-more-row">
				<button
					type="button"
					class="clickable-icon epub-notes-more-btn"
					title={'更多操作'}
					aria-label={'更多操作'}
					onclick={(event) => openPanelMenu(event)}
				>
					<span use:iconAction={'more-horizontal'}></span>
				</button>
			</div>
		{/if}
		{#if selectionMode}
			<div
				class="epub-notes-selection-float"
				role="toolbar"
				aria-label={'批量选择'}
				aria-live="polite"
			>
				<span class="epub-notes-selection-count" aria-label={selectionCountLabel}>
					<span class="epub-notes-selection-count-selected">{selectedHighlights.length}</span>
					<span class="epub-notes-selection-count-sep">/</span>
					<span class="epub-notes-selection-count-total">{filteredHighlights.length}</span>
				</span>
				<span class="epub-notes-selection-divider" aria-hidden="true"></span>
				<div class="epub-notes-selection-actions">
					<button
						type="button"
						class="clickable-icon epub-notes-selection-icon-btn"
						title={'粘贴所选摘录到笔记'}
						aria-label={'粘贴所选摘录到笔记'}
						disabled={selectedHighlights.length === 0 || !onPasteHighlights || pasting}
						onclick={() => void pasteSelectedHighlights()}
					>
						<span use:iconAction={'clipboard-paste'}></span>
					</button>
					<span class="epub-notes-selection-divider" aria-hidden="true"></span>
					<button
						type="button"
						class="clickable-icon epub-notes-selection-icon-btn epub-notes-selection-icon-btn--danger"
						title={'删除所选摘录'}
						aria-label={'删除所选摘录'}
						disabled={selectedHighlights.length === 0 || !onDeleteHighlight || batchDeleting}
						onclick={() => void deleteSelectedHighlights()}
					>
						<span use:iconAction={'trash-2'}></span>
					</button>
					<button
						type="button"
						class="clickable-icon epub-notes-selection-icon-btn"
						title={'更多操作'}
						aria-label={'更多操作'}
						onclick={(event) => openBatchMenu(event)}
					>
						<span use:iconAction={'more-horizontal'}></span>
					</button>
					<button
						type="button"
						class="clickable-icon epub-notes-selection-icon-btn"
						title={'退出批量选择'}
						aria-label={'退出批量选择'}
						onclick={exitSelectionMode}
					>
						<span use:iconAction={'x'}></span>
					</button>
				</div>
			</div>
		{/if}
		{#if syncing}
			<div class="epub-notes-sync-hint" aria-live="polite">{'正在同步摘录…'}</div>
		{/if}
		{#if filteredHighlights.length > 0}
			<section class="notes-section">
				<div class="notes-section-list">
					{#each filteredHighlights as hl (getHighlightSelectionKey(hl))}
						<EpubAnnotationCard
							clickable={true}
							selectionMode={selectionMode}
							selected={selectedKeys.has(getHighlightSelectionKey(hl))}
							onActivate={() => handleHighlightActivate(hl)}
							onContextMenu={(event) => showHighlightContextMenu(event, hl)}
							color={hl.color}
							quoteHtml={hl.quoteHtml}
							quoteText={hl.quoteHtml ? undefined : hl.text}
							commentText={hl.hasCommentDivider ? (hl.commentText || '想法为空') : getEmptyExcerptHint(hl.text)}
							commentMuted={!hl.hasCommentDivider}
							metaLeft={getSourceLabel(hl.sourceFile)}
							metaRightPrefix={formatTime(hl.createdTime)}
							metaRight={hl.pageLabel || getHighlightChapterLabel(hl)}
						/>
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.epub-notes-sync-hint {
		flex: 0 0 auto;
		padding: 4px 12px 0;
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
	}

	.epub-notes-panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 14px 12px 22px;
		position: relative;
		min-height: 100%;
		box-sizing: border-box;
	}

	/* 移动端「更多操作」入口：右键不可靠，面板级操作收进这个按钮。 */
	.epub-notes-more-row {
		display: flex;
		justify-content: flex-end;
		margin: -4px 0 -8px;
	}

	.epub-notes-more-btn {
		color: var(--text-muted);
	}

	.epub-notes-panel.selection-mode {
		padding-top: 6px;
	}

	.epub-notes-selection-float {
		position: sticky;
		top: 6px;
		z-index: 6;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
		padding: 6px 8px 6px 12px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 72%, transparent);
		background: color-mix(in srgb, var(--background-primary) 88%, transparent);
		box-shadow:
			0 10px 28px rgba(0, 0, 0, 0.16),
			0 1px 0 color-mix(in srgb, white 8%, transparent) inset;
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		align-self: center;
		width: fit-content;
		max-width: calc(100% - 8px);
		margin-inline: auto;
	}

	.epub-notes-selection-count {
		display: inline-flex;
		align-items: baseline;
		gap: 1px;
		font-size: var(--font-ui-smaller);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: var(--text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.epub-notes-selection-count-selected {
		font-weight: 700;
		color: var(--text-normal);
	}

	.epub-notes-selection-count-sep {
		opacity: 0.55;
		padding-inline: 1px;
	}

	.epub-notes-selection-divider {
		width: 1px;
		height: 18px;
		background: color-mix(in srgb, var(--background-modifier-border) 88%, transparent);
		flex-shrink: 0;
	}

	.epub-notes-selection-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	:global(.epub-notes-panel .epub-notes-selection-icon-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: none;
		border-radius: var(--clickable-icon-radius);
		background: transparent;
		box-shadow: none;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	:global(.epub-notes-panel .epub-notes-selection-icon-btn .svg-icon) {
		width: var(--icon-s);
		height: var(--icon-s);
	}

	:global(.epub-notes-panel .epub-notes-selection-icon-btn:hover:not(:disabled)) {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	:global(.epub-notes-panel .epub-notes-selection-icon-btn--danger:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--text-error) 12%, transparent);
		color: var(--text-error);
	}

	:global(.epub-notes-panel .epub-notes-selection-icon-btn:disabled) {
		opacity: 0.38;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.epub-notes-selection-float {
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}
	}

	.epub-placeholder {
		padding: 22px 14px;
		border-radius: 16px;
		background: color-mix(in srgb, var(--weave-elevated-background, var(--background-secondary)) 88%, transparent);
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.7;
	}

	.notes-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.notes-section-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
