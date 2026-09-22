import {
	ItemView,
	type KeymapEventHandler,
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Scope,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import { unknownPlainText } from "../utils/unknown-plain-text";
import { domInstanceOf } from "../utils/dom-instance-of";
import type {
	EpubExcerptSettings,
	EpubFlowMode,
	EpubLayoutMode,
	EpubReaderSettings,
	EpubReadingReferencePoint,
} from "../services/epub";
import { stripSupportedBookExtension } from "../services/epub/book-format";
import { EPUB_RUNTIME } from "../services/epub";
import { reportEpubError } from "../services/epub/epub-error";
import { resolveRecentEpubPath } from "../utils/epub-leaf-utils";
import {
	pendingLocateFromLegacyState,
	type PendingLocateState,
} from "../services/navigation/navigation-intent";
import { getBookSessionManager } from "../services/epub/session/book-session-manager-access";
import { logger } from "../utils/logger";
import { getViewSurfaceTokens } from "../utils/view-location-utils";
import type { ViewSurfaceTokens } from "../utils/view-location-utils";
import {
	canHandleEpubPagedNavigation,
	shouldIgnoreEpubReaderShortcut,
} from "../utils/epub-reader-keyboard-guards";
import type { EpubViewHost } from "./epub-view-host";
import { VIEW_TYPE_EPUB_SIDEBAR } from "./EpubSidebarView";

export const VIEW_TYPE_EPUB = EPUB_RUNTIME.viewTypes.reader;

export class EpubView extends ItemView {
	private component: unknown = null;
	private plugin: EpubViewHost;
	private filePath = "";
	private bookTitle = "";
	private chapterTitle = "";
	private isOpen = false;
	private pendingCfi = "";
	private pendingText = "";
	private pendingLocate: PendingLocateState | null = null;
	private autoInsertEnabled = false;
	private layoutMode: EpubLayoutMode = "paginated";
	private flowMode: EpubFlowMode = "paginated";
	private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;
	private leafChangeHandler: unknown = null;
	private layoutChangeHandler: unknown = null;
	private mounting = false;
	private pendingRemount = false;
	private readerHostEl: HTMLDivElement | null = null;
	private inlineToolbarEl: HTMLDivElement | null = null;
	private inlineToolbarActionsEl: HTMLDivElement | null = null;
	private inlineToolbarToggleBtn: HTMLButtonElement | null = null;
	private inlineToolbarExpanded = false;
	private sidebarBtn: HTMLElement | null = null;
	private inlineSidebarBtn: HTMLButtonElement | null = null;
	private autoInsertBtn: HTMLElement | null = null;
	private inlineAutoInsertBtn: HTMLButtonElement | null = null;
	private flowBtn: HTMLElement | null = null;
	private inlineFlowBtn: HTMLButtonElement | null = null;
	private layoutBtn: HTMLElement | null = null;
	private inlineLayoutBtn: HTMLButtonElement | null = null;
	private readingReferenceBtn: HTMLElement | null = null;
	private inlineReadingReferenceBtn: HTMLButtonElement | null = null;
	private hasReadingReferencePoint = false;
	private bookmarkBtn: HTMLElement | null = null;
	private readingPositionAutoSaveEnabled = false;
	private toolbarHandlersReady = false;
	private readerKeymapHandlers: KeymapEventHandler[] = [];
	private actionHandlers: {
		setAutoInsert?: (enabled: boolean) => void;
		setLayoutMode?: (mode: EpubLayoutMode) => void;
		setFlowMode?: (mode: EpubFlowMode) => void;
		openTypographyPanel?: () => void;
		getReaderSettings?: () => EpubReaderSettings;
		updateReaderSettings?: (patch: Partial<EpubReaderSettings>) => Promise<void>;
		navigateToCfi?: (cfi: string, linkTextHint?: string) => void;
		addBookmark?: () => Promise<void>;
		canUseReadingProgress?: () => boolean;
		canUseReadingReference?: () => boolean;
		canUseExcerptNotes?: () => boolean;
		canUseStyledExcerpts?: () => boolean;
		canUseFootnotePreview?: () => boolean;
		saveReadingReferencePoint?: () => Promise<void>;
		openReadingPositionMenu?: (event: MouseEvent | KeyboardEvent) => void;
		getReadingPositionAutoSaveEnabled?: () => boolean;
		setReadingPositionAutoSaveEnabled?: (enabled: boolean) => Promise<boolean>;
		getExcerptSettings?: () => EpubExcerptSettings;
		updateExcerptSettings?: (patch: Partial<EpubExcerptSettings>) => Promise<void>;
		prevPage?: () => void | Promise<void>;
		nextPage?: () => void | Promise<void>;
	} = {};

	constructor(leaf: WorkspaceLeaf, plugin: EpubViewHost) {
		super(leaf);
		this.plugin = plugin;
	}

	private canUseReadingProgress(): boolean {
		return Boolean(this.actionHandlers.canUseReadingProgress?.());
	}

	private canUseReadingReference(): boolean {
		return Boolean(this.actionHandlers.canUseReadingReference?.());
	}

	private canHandleKeyboardPageNavigation(): boolean {
		return canHandleEpubPagedNavigation({
			hasOpenBook: Boolean(this.filePath),
			flowMode: this.flowMode,
		});
	}

	private disposeReaderKeymapScope(): void {
		const scope = this.scope;
		if (!scope) {
			this.readerKeymapHandlers = [];
			return;
		}
		for (const handler of this.readerKeymapHandlers) {
			scope.unregister(handler);
		}
		this.readerKeymapHandlers = [];
		this.scope = null;
	}

	private registerReaderKeyboardShortcuts(): void {
		this.disposeReaderKeymapScope();
		const scope = new Scope(this.app.scope);
		this.scope = scope;
		this.readerKeymapHandlers = [
			scope.register([], "ArrowLeft", (evt) => {
				if (!this.canHandleKeyboardPageNavigation()) {
					return;
				}
				if (shouldIgnoreEpubReaderShortcut(evt)) {
					return;
				}
				void this.actionHandlers.prevPage?.();
				return false;
			}),
			scope.register([], "ArrowRight", (evt) => {
				if (!this.canHandleKeyboardPageNavigation()) {
					return;
				}
				if (shouldIgnoreEpubReaderShortcut(evt)) {
					return;
				}
				void this.actionHandlers.nextPage?.();
				return false;
			}),
		];
	}

	private canUseExcerptNotes(): boolean {
		return Boolean(this.actionHandlers.canUseExcerptNotes?.());
	}

	private canUseStyledExcerpts(): boolean {
		return Boolean(this.actionHandlers.canUseStyledExcerpts?.());
	}

	private canUseFootnotePreview(): boolean {
		return Boolean(this.actionHandlers.canUseFootnotePreview?.());
	}

	private shouldShowToolbarFeature(): boolean {
		return this.plugin.isAutoInsertButtonOnReaderVisible?.() ?? false;
	}

	/** 设置页切换「在阅读页显示自动化按钮」后，刷新已打开阅读视图的按钮显隐。 */
	refreshAutoInsertButtonVisibility(): void {
		this.updateAutoInsertBtn();
	}

	private areHeaderActionsMounted(): boolean {
		return Boolean(this.autoInsertBtn?.isConnected);
	}

	private clearHeaderActionRefs(): void {
		this.sidebarBtn = null;
		this.autoInsertBtn = null;
		this.bookmarkBtn = null;
		this.readingReferenceBtn = null;
		this.flowBtn = null;
		this.layoutBtn = null;
	}

	private registerReaderHeaderActions(): void {
		if (this.areHeaderActionsMounted()) {
			return;
		}

		this.clearHeaderActionRefs();

		if (!Platform.isMobile) {
			this.sidebarBtn = this.addAction("list", '切换侧边栏', () => {
				void this.toggleGlobalSidebar();
			});
		}

		const registerExcerptHeaderActions = () => {
			this.autoInsertBtn = this.addAction("zap", '自动化', () => {
				this.autoInsertEnabled = !this.autoInsertEnabled;
				this.updateAutoInsertBtn();
				this.actionHandlers.setAutoInsert?.(this.autoInsertEnabled);
			});
		};

		registerExcerptHeaderActions();

		if (!Platform.isMobile) {
			this.bookmarkBtn = this.addAction("bookmark", '添加当前页书签', () => {
				void this.actionHandlers.addBookmark?.();
			});
			this.readingReferenceBtn = this.addAction(
				"flag",
				'阅读位置',
				(evt) => {
					this.openReadingPositionMenu(evt);
				}
			);
		}

		if (!Platform.isMobile) {
			this.flowBtn = this.addAction(
				"arrow-up-down",
				'翻页',
				() => {
					this.toggleFlowMode();
				}
			);
			this.layoutBtn = this.addAction(
				"scroll-text",
				'单栏',
				() => {
					this.cycleLayoutMode();
				}
			);

			this.positionFlowBtn();
		}
	}

	private syncToolbarAfterActionsReady(): void {
		this.toolbarHandlersReady = true;
		this.refreshAllActionButtons();
		window.requestAnimationFrame(() => {
			if (!this.toolbarHandlersReady) {
				return;
			}
			this.refreshAllActionButtons();
		});
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB;
	}

	getDisplayText(): string {
		return this.getResolvedHeaderTitle();
	}

	getIcon(): string {
		return "book-open";
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);

		const excerptSettings = this.actionHandlers.getExcerptSettings?.();
		const readerSettings = this.actionHandlers.getReaderSettings?.();

		if (readerSettings && this.actionHandlers.updateReaderSettings) {
			this.appendReadingAndDisplayPaneMenu(menu, readerSettings);
		}

		this.appendBookmarksProgressPaneMenu(menu);

		if (excerptSettings && this.actionHandlers.updateExcerptSettings) {
			this.appendExcerptToolsPaneMenu(menu, excerptSettings);
		}

	}

	private addPaneMenuGroup(
		menu: Menu,
		title: string,
		icon: string,
		populate: (subMenu: Menu) => void
	): void {
		menu.addItem((item) => {
			item.setTitle(title);
			item.setIcon(icon);
			const subMenu = this.resolveMenuSubmenu(item, menu);
			populate(subMenu);
		});
	}

	private resolveMenuSubmenu(item: unknown, fallbackMenu: Menu): Menu {
		const candidate = item as { setSubmenu?: () => Menu };
		if (typeof candidate.setSubmenu === "function") {
			return candidate.setSubmenu();
		}
		return fallbackMenu;
	}

	private appendReadingFlowModeItems(subMenu: Menu): void {
		subMenu.addItem((item) => {
			item.setTitle('连续滚动');
			item.setIcon("scroll-text");
			item.setChecked(this.flowMode === "scrolled");
			item.onClick(() => {
				if (this.flowMode === "scrolled") {
					return;
				}
				this.flowMode = "scrolled";
				this.layoutMode = "paginated";
				this.updateFlowBtn();
				this.updateLayoutBtn();
				this.actionHandlers.setFlowMode?.("scrolled");
			});
		});
		subMenu.addItem((item) => {
			item.setTitle('翻页');
			item.setIcon("arrow-up-down");
			item.setChecked(this.flowMode === "paginated");
			item.onClick(() => {
				if (this.flowMode === "paginated") {
					return;
				}
				this.flowMode = "paginated";
				this.updateFlowBtn();
				this.updateLayoutBtn();
				this.actionHandlers.setFlowMode?.("paginated");
			});
		});
	}

	private appendReadingAndDisplayPaneMenu(menu: Menu, readerSettings: EpubReaderSettings): void {
		this.addPaneMenuGroup(menu, '阅读与显示', "book-open-text", (subMenu) => {
			this.appendReadingFlowModeItems(subMenu);

			subMenu.addItem((item) => {
				item.setTitle('连续滚动侧边翻页键');
				item.setIcon("panel-right");
				item.setChecked(readerSettings.showScrolledSideNav);
				item.onClick(() => {
					void this.actionHandlers.updateReaderSettings?.({
						showScrolledSideNav: !readerSettings.showScrolledSideNav,
					});
				});
			});

			if (!this.filePath) {
				return;
			}

			subMenu.addItem((item) => {
				item.setTitle('阅读排版调节');
				item.setIcon("sliders-horizontal");
				item.onClick(() => {
					window.setTimeout(() => {
						this.actionHandlers.openTypographyPanel?.();
					}, 0);
				});
			});

			if (this.canUseFootnotePreview()) {
				subMenu.addItem((item) => {
					item.setTitle('点击脚注序号');
					item.setIcon("mouse-pointer");
					const footnoteMenu = this.resolveMenuSubmenu(item, subMenu);

					footnoteMenu.addItem((subItem) => {
						subItem.setTitle('显示脚注浮窗');
						subItem.setChecked(readerSettings.footnoteClickAction === "preview");
						subItem.onClick(() => {
							void this.actionHandlers.updateReaderSettings?.({
								footnoteClickAction: "preview",
							});
						});
					});

					footnoteMenu.addItem((subItem) => {
						subItem.setTitle('跳转到脚注位置');
						subItem.setChecked(readerSettings.footnoteClickAction === "navigate");
						subItem.onClick(() => {
							void this.actionHandlers.updateReaderSettings?.({
								footnoteClickAction: "navigate",
							});
						});
					});
				});
			}
		});
	}

	private appendBookmarksProgressPaneMenu(menu: Menu): void {
		this.addPaneMenuGroup(menu, '书签与进度', "bookmark", (bookmarksMenu) => {
			bookmarksMenu.addItem((subItem) => {
				subItem.setTitle('添加当前页书签');
				subItem.setIcon("bookmark");
				subItem.onClick(() => {
					void this.actionHandlers.addBookmark?.();
				});
			});

			bookmarksMenu.addItem((subItem) => {
				subItem.setTitle('阅读位置');
				subItem.setIcon("flag");
				subItem.setChecked(this.hasReadingReferencePoint);
				subItem.onClick((evt) => {
					this.openReadingPositionMenu(evt);
				});
			});

		});
	}

	private populateExcerptToolToggleItems(excerptToolsMenu: Menu): void {
		excerptToolsMenu.addItem((subItem) => {
			subItem.setTitle(
				'自动化'
			);
			subItem.setIcon("zap");
			subItem.setChecked(this.canUseExcerptNotes() ? this.autoInsertEnabled : false);
			subItem.onClick(() => {
				this.autoInsertEnabled = !this.autoInsertEnabled;
				this.updateAutoInsertBtn();
				this.actionHandlers.setAutoInsert?.(this.autoInsertEnabled);
			});
		});
	}

	private populateExcerptNotesSettings(subMenu: Menu, excerptSettings: EpubExcerptSettings): void {
		if (this.canUseExcerptNotes()) {
			subMenu.addItem((item) => {
				item.setTitle('最新摘录在最上');
				item.setIcon("arrow-up-narrow-wide");
				item.setChecked(excerptSettings.newestExcerptOnTop);
				item.onClick(() => {
					void this.actionHandlers.updateExcerptSettings?.({
						newestExcerptOnTop: !excerptSettings.newestExcerptOnTop,
					});
				});
			});

			subMenu.addItem((item) => {
				item.setTitle('摘录时间戳');
				item.setIcon("clock");
				item.setChecked(excerptSettings.addCreationTime);
				item.onClick(() => {
					void this.actionHandlers.updateExcerptSettings?.({
						addCreationTime: !excerptSettings.addCreationTime,
					});
				});
			});

			subMenu.addItem((item) => {
				item.setTitle('章节定位');
				item.setIcon("map-pin");
				const chapterLocationMenu = this.resolveMenuSubmenu(item, subMenu);
				const formatOptions = [
					{ format: "root" as const, label: '仅顶层（A）' },
					{ format: "leaf" as const, label: '仅末级（C）' },
					{ format: "full" as const, label: '完整路径（A/B/C）' },
				];
				for (const option of formatOptions) {
					chapterLocationMenu.addItem((subItem) => {
						subItem.setTitle(option.label);
						subItem.setChecked(excerptSettings.chapterLocationFormat === option.format);
						subItem.onClick(() => {
							if (excerptSettings.chapterLocationFormat === option.format) {
								return;
							}
							void this.actionHandlers.updateExcerptSettings?.({
								chapterLocationFormat: option.format,
							});
						});
					});
				}
			});
		}

		if (this.canUseStyledExcerpts()) {
				subMenu.addItem((item) => {
					item.setTitle('隐藏文本');
					item.setIcon("eye");
					const concealedMenu = this.resolveMenuSubmenu(item, subMenu);

					concealedMenu.addItem((subItem) => {
						subItem.setTitle('隐藏删除线文本');
						subItem.setChecked(excerptSettings.strikethroughDisplayMode === "conceal");
						subItem.onClick(() => {
							void this.actionHandlers.updateExcerptSettings?.({
								strikethroughDisplayMode:
									excerptSettings.strikethroughDisplayMode === "conceal"
										? "strikethrough"
										: "conceal",
							});
						});
					});

					concealedMenu.addItem((subItem) => {
						subItem.setTitle('侧边栏显示隐藏文本与删除线');
						subItem.setChecked(excerptSettings.showStrikethroughInSidebar);
						subItem.onClick(() => {
							void this.actionHandlers.updateExcerptSettings?.({
								showStrikethroughInSidebar: !excerptSettings.showStrikethroughInSidebar,
							});
						});
					});
				});
		}

	}

	private appendExcerptToolsPaneMenu(menu: Menu, excerptSettings: EpubExcerptSettings): void {
		if (!this.shouldShowToolbarFeature()) {
			return;
		}

		this.addPaneMenuGroup(menu, '摘录工具与设置', "highlighter", (excerptToolsMenu) => {
			this.populateExcerptToolToggleItems(excerptToolsMenu);

			if (this.filePath) {
				excerptToolsMenu.addSeparator();
				this.populateExcerptNotesSettings(excerptToolsMenu, excerptSettings);
			}
		});
	}



	allowNoFile(): boolean {
		return true;
	}

	getCurrentFilePath(): string {
		return normalizePath(this.filePath || "");
	}

	getState(): unknown {
		return { filePath: this.filePath, file: this.filePath };
	}

	async setState(state: unknown, result: unknown): Promise<void> {
		await super.setState(state, result);

		const viewState =
			state && typeof state === "object" && !Array.isArray(state)
				? (state as Record<string, unknown>)
				: {};
		const incomingPath = unknownPlainText(viewState.filePath || viewState.file).trim();

		const incomingPending = pendingLocateFromLegacyState({
			pendingLocate:
				viewState.pendingLocate && typeof viewState.pendingLocate === "object"
					? (viewState.pendingLocate as PendingLocateState)
					: undefined,
			pendingCfi: typeof viewState.pendingCfi === "string" ? viewState.pendingCfi : undefined,
			pendingText: typeof viewState.pendingText === "string" ? viewState.pendingText : undefined,
		});
		if (incomingPending) {
			this.pendingLocate = incomingPending;
			this.pendingCfi = incomingPending.cfi || "";
			this.pendingText = incomingPending.text || "";
		}

		if (incomingPath && incomingPath !== this.filePath) {
			this.filePath = incomingPath;
			this.bookTitle = "";
			this.chapterTitle = "";
			this.hasReadingReferencePoint = false;
			this.refreshAllActionButtons();
			this.refreshInlineToolbarVisibility();
			this.refreshViewTitle();
			if (this.isOpen) {
				await this.mountComponent();
			}
		} else if (incomingPath && !this.component && this.isOpen) {
			this.filePath = incomingPath;
			this.refreshInlineToolbarVisibility();
			this.refreshViewTitle();
			await this.mountComponent();
		} else if (this.pendingLocate && this.component) {
			this.flushPendingLocateToReader();
		}
	}

	async onOpen(): Promise<void> {
		this.isOpen = true;
		this.toolbarHandlersReady = false;
		this.contentEl.empty();
		this.contentEl.addClass("weave-epub-view-content");
		this.ensureViewShell();
		this.refreshViewTitle();
		this.registerReaderKeyboardShortcuts();
		this.registerReaderHeaderActions();

		if (!Platform.isMobile) {
			this.moveSidebarBtnToNav();
			this.refreshInlineToolbarVisibility();
		}
		this.setupLeafChangeTracking();
		this.setupLinkedTabTracking();

		if (this.filePath) {
			await this.mountComponent();
		}
	}

	private async toggleGlobalSidebar(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_EPUB_SIDEBAR);
		if (existing.length > 0) {
			for (const leaf of existing) {
				leaf.detach();
			}
			return;
		}

		const leftLeaf = workspace.getLeftLeaf(false);
		if (leftLeaf) {
			await leftLeaf.setViewState({
				type: VIEW_TYPE_EPUB_SIDEBAR,
				active: true,
			});
			void workspace.revealLeaf(leftLeaf);
		}
	}

	private moveSidebarBtnToNav(): void {
		if (!this.sidebarBtn) return;
		const navButtons = this.containerEl.querySelector(".view-header-nav-buttons");
		if (navButtons) {
			navButtons.appendChild(this.sidebarBtn);
		}
	}

	private ensureViewShell(): void {
		if (this.readerHostEl?.isConnected) {
			this.applySurfaceContext();
			return;
		}

		this.contentEl.empty();
		const shellEl = this.contentEl.createDiv({ cls: "weave-epub-view-shell" });
		this.readerHostEl = shellEl.createDiv({ cls: "weave-epub-reader-host" });
		this.applySurfaceContext();

		if (!Platform.isMobile) {
			this.buildInlineToolbar(shellEl);
		}
	}

	private applySurfaceContext(): void {
		let surfaceTokens: ViewSurfaceTokens = {
			context: "main",
			surfaceBackground: "var(--background-primary)",
			elevatedBackground: "var(--background-secondary)",
		};
		try {
			surfaceTokens = getViewSurfaceTokens(this.leaf);
		} catch {
			// In partial workspace states, fall back to the main-surface token set.
		}
		const targets = [this.contentEl, this.readerHostEl, this.readerHostEl?.parentElement].filter(
			Boolean
		) as HTMLElement[];

		for (const target of targets) {
			target.dataset.weaveSurfaceContext = surfaceTokens.context;
			target.style.setProperty("--weave-surface-background", surfaceTokens.surfaceBackground);
			target.style.setProperty("--weave-elevated-background", surfaceTokens.elevatedBackground);
		}
	}


	private buildInlineToolbar(shellEl: HTMLDivElement): void {
		this.inlineToolbarEl = shellEl.createDiv({ cls: "epub-left-inline-toolbar" });
		this.inlineToolbarToggleBtn = this.createInlineToolbarButton(
			"chevrons-right",
			'展开 EPUB 工具栏',
			() => {
				this.inlineToolbarExpanded = !this.inlineToolbarExpanded;
				this.updateInlineToolbarExpandedState();
			}
		);
		this.inlineToolbarToggleBtn.addClass("epub-left-inline-toolbar-toggle");
		this.inlineToolbarEl.appendChild(this.inlineToolbarToggleBtn);

		this.inlineToolbarActionsEl = this.inlineToolbarEl.createDiv({
			cls: "epub-left-inline-toolbar-actions",
		});
		this.inlineSidebarBtn = this.appendInlineActionButton(
			"list",
			'切换侧边栏',
			() => {
				void this.toggleGlobalSidebar();
			}
		);
		this.inlineAutoInsertBtn = this.appendInlineActionButton(
			"zap",
			'自动模式（关：复制，开：插入）',
			() => {
				this.autoInsertEnabled = !this.autoInsertEnabled;
				this.updateAutoInsertBtn();
				this.actionHandlers.setAutoInsert?.(this.autoInsertEnabled);
			}
		);
		this.inlineFlowBtn = this.appendInlineActionButton(
			"arrow-up-down",
			'翻页',
			() => {
				this.toggleFlowMode();
			}
		);
		this.inlineLayoutBtn = this.appendInlineActionButton(
			"scroll-text",
			'单栏',
			() => {
				this.cycleLayoutMode();
			}
		);
		this.inlineReadingReferenceBtn = this.appendInlineActionButton(
			"flag",
			'阅读位置',
			(evt) => {
				this.openReadingPositionMenu(evt);
			}
		);

		this.updateInlineToolbarExpandedState();
		this.refreshAllActionButtons();
		this.refreshInlineToolbarVisibility();
	}

	private appendInlineActionButton(
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void
	): HTMLButtonElement {
		const button = this.createInlineToolbarButton(icon, label, onClick);
		this.inlineToolbarActionsEl?.appendChild(button);
		return button;
	}

	private createInlineToolbarButton(
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void
	): HTMLButtonElement {
		const button = activeWindow.createEl("button");
		button.type = "button";
		button.className = "epub-left-inline-toolbar-btn clickable-icon";
		setIcon(button, icon);
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		button.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			onClick(evt);
		});
		return button;
	}

	private updateInlineToolbarExpandedState(): void {
		this.inlineToolbarEl?.toggleClass("is-expanded", this.inlineToolbarExpanded);
		this.inlineToolbarActionsEl?.toggleClass("is-expanded", this.inlineToolbarExpanded);
		if (!this.inlineToolbarToggleBtn) {
			return;
		}
		const icon = this.inlineToolbarExpanded ? "chevrons-left" : "chevrons-right";
		const label = this.inlineToolbarExpanded
			? '收起 EPUB 工具栏'
			: '展开 EPUB 工具栏';
		setIcon(this.inlineToolbarToggleBtn, icon);
		this.inlineToolbarToggleBtn.setAttribute("aria-label", label);
		this.inlineToolbarToggleBtn.setAttribute("title", label);
		this.inlineToolbarToggleBtn.toggleClass("is-active", this.inlineToolbarExpanded);
	}

	private refreshInlineToolbarVisibility(): void {
		if (!this.inlineToolbarEl) {
			return;
		}
		const shouldShow = !Platform.isMobile && Boolean(this.filePath);
		this.inlineToolbarEl.toggleClass("is-hidden", !shouldShow);
	}

	private refreshAllActionButtons(): void {
		this.updateAutoInsertBtn();
		this.updateReadingReferencePointBtn();
		this.updateFlowBtn();
		this.updateLayoutBtn();
	}

	private applyActionButtonState(
		button: HTMLElement | null,
		options: {
			icon?: string;
			label?: string;
			active?: boolean;
			visible?: boolean;
		}
	): void {
		if (!button) {
			return;
		}
		if (options.icon) {
			setIcon(button, options.icon);
		}
		if (options.label) {
			button.setAttribute("aria-label", options.label);
			button.setAttribute("title", options.label);
		}
		if (typeof options.active === "boolean") {
			button.toggleClass("is-active", options.active);
		}
		if (typeof options.visible === "boolean") {
			if (!options.visible && !this.toolbarHandlersReady) {
				return;
			}
			button.toggleClass("epub-view-action-hidden", !options.visible);
		}
	}

	private positionFlowBtn(): void {
		if (!this.flowBtn || !this.layoutBtn) return;
		const parent = this.layoutBtn.parentElement;
		if (!parent || parent !== this.flowBtn.parentElement) return;

		const direction = window.getComputedStyle(parent).flexDirection;
		if (direction === "row-reverse") {
			if (this.layoutBtn.nextSibling !== this.flowBtn) {
				parent.insertBefore(this.flowBtn, this.layoutBtn.nextSibling);
			}
			return;
		}

		if (this.layoutBtn.previousSibling !== this.flowBtn) {
			parent.insertBefore(this.flowBtn, this.layoutBtn);
		}
	}

	private getResolvedBookTitle(): string {
		if (this.bookTitle.trim()) {
			return this.bookTitle.trim();
		}

		if (this.filePath) {
			const fileName = this.filePath.split(/[\\/]/).pop() || this.filePath;
			const titleFromFile = stripSupportedBookExtension(fileName).trim();
			if (titleFromFile) {
				return titleFromFile;
			}
		}

		return '我的书架';
	}

	private getResolvedHeaderTitle(): string {
		const bookTitle = this.getResolvedBookTitle();
		const chapterTitle = this.chapterTitle.trim();
		if (!chapterTitle || chapterTitle === bookTitle) {
			return bookTitle;
		}
		return `${bookTitle} - ${chapterTitle}`;
	}

	private refreshViewTitle(): void {
		const title = this.getResolvedHeaderTitle();

		try {
			const leafWithHeader = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
			if (leafWithHeader && typeof leafWithHeader.updateHeader === "function") {
				leafWithHeader.updateHeader();
			}

			this.app.workspace.trigger("layout-change");

			const titleEl = this.leaf?.view?.containerEl?.querySelector(".view-header-title");
			if (domInstanceOf(titleEl, HTMLElement)) {
				titleEl.textContent = title;
				titleEl.setAttribute("aria-label", title);
			}
		} catch (error) {
			logger.warn("[EpubView] Failed to refresh view title:", error);
		}
	}

	private async mountComponent(): Promise<void> {
		if (this.mounting) {
			this.pendingRemount = true;
			return;
		}

		const mountedFilePath = this.filePath;
		this.mounting = true;
		this.pendingRemount = false;
		try {
			this.ensureViewShell();

			if (this.component) {
				const { unmount } = await import("svelte");
				try {
					void unmount(this.component);
				} catch {
					/* ignore */
				}
				this.component = null;
			}
			this.readerHostEl?.empty();

			const { mount } = await import("svelte");
			const { default: EpubReaderApp } = await import("../components/epub/EpubReaderApp.svelte");
			if (!this.readerHostEl) {
				throw new Error("EPUB reader host is unavailable");
			}

			const {
				pendingLocate: initialPendingLocate,
				pendingCfi: initialPendingCfi,
				pendingText: initialPendingText,
			} = this.consumePendingNavigation();

			this.component = mount(EpubReaderApp, {
				target: this.readerHostEl,
				props: this.buildReaderAppProps(
					initialPendingLocate,
					initialPendingCfi,
					initialPendingText
				),
			});

			logger.debug("[EpubView] EPUB component mounted:", this.filePath);
		} catch (error) {
			const classified = reportEpubError(error, "open");
			this.readerHostEl?.empty();
			this.readerHostEl?.createDiv({
				cls: "epub-error-state",
				text: classified.userMessage,
			});
		} finally {
			this.mounting = false;
			if (this.pendingRemount || mountedFilePath !== this.filePath) {
				this.pendingRemount = false;
				void this.mountComponent();
			}
		}
	}

	private consumePendingNavigation(): {
		pendingLocate: PendingLocateState | null;
		pendingCfi: string;
		pendingText: string;
	} {
		const pendingLocate =
			this.pendingLocate ||
			pendingLocateFromLegacyState({
				pendingCfi: this.pendingCfi,
				pendingText: this.pendingText,
			});
		const pendingNavigation = {
			pendingLocate,
			pendingCfi: this.pendingCfi,
			pendingText: this.pendingText,
		};
		this.pendingLocate = null;
		this.pendingCfi = "";
		this.pendingText = "";
		return pendingNavigation;
	}

	private flushPendingLocateToReader(): void {
		const pending = this.pendingLocate;
		this.pendingLocate = null;
		this.pendingCfi = "";
		this.pendingText = "";
		if (!pending) {
			return;
		}
		const cfi = pending.cfi || pending.href || "";
		if (cfi) {
			this.actionHandlers.navigateToCfi?.(cfi, pending.text || "");
		}
	}

	private buildReaderAppProps(
		initialPendingLocate: PendingLocateState | null,
		initialPendingCfi: string,
		initialPendingText: string
	) {
		return {
			app: this.app,
			filePath: this.filePath,
			onTitleChange: (title: string) => {
				this.bookTitle = title;
				this.refreshViewTitle();
			},
			onChapterTitleChange: (title: string) => {
				this.chapterTitle = String(title || "").trim();
				this.refreshViewTitle();
			},
			onReaderSettingsLoaded: (settings: {
				layoutMode: EpubLayoutMode;
				flowMode: EpubFlowMode;
			}) => {
				this.layoutMode = settings.layoutMode;
				this.flowMode = settings.flowMode;
				this.updateFlowBtn();
				this.updateLayoutBtn();
			},
			onReadingReferencePointChange: (point: EpubReadingReferencePoint | null) => {
				this.hasReadingReferencePoint = Boolean(point);
				this.updateReadingReferencePointBtn();
			},
			onReadingPositionAutoSaveChange: () => {
				this.updateReadingReferencePointBtn();
			},

			pendingLocate: initialPendingLocate,
			pendingCfi: initialPendingCfi,
			pendingText: initialPendingText,
			autoInsertEnabled: this.autoInsertEnabled,
			getLastActiveMarkdownLeaf: () => this.getValidMarkdownLeaf(),
			onBackFromBookshelf: async () => {
				await this.returnFromBookshelfToRecentBook();
			},
			onCancelBookLoad: async () => {
				this.leaf.detach();
			},
			onActionsReady: (actions: typeof this.actionHandlers) => {
				this.actionHandlers = actions;
				if (!this.areHeaderActionsMounted()) {
					this.registerReaderHeaderActions();
					if (!Platform.isMobile) {
						this.moveSidebarBtnToNav();
					}
				}
				const readerSettings = actions.getReaderSettings?.();
				if (readerSettings) {
					this.layoutMode = readerSettings.layoutMode;
					this.flowMode = readerSettings.flowMode;
				}
				this.syncToolbarAfterActionsReady();
			},
			onSwitchBook: async (newFilePath: string) => {
				await this.switchBookInCurrentLeaf(newFilePath);
			},
		};
	}

	async onClose(): Promise<void> {
		this.toolbarHandlersReady = false;

		if (this.leafChangeHandler) {
			this.app.workspace.off("active-leaf-change", this.leafChangeHandler);
			this.leafChangeHandler = null;
		}
		if (this.layoutChangeHandler) {
			this.app.workspace.off("layout-change", this.layoutChangeHandler);
			this.layoutChangeHandler = null;
		}
		if (this.component) {
			const { unmount } = await import("svelte");
			try {
				void unmount(this.component);
			} catch {
				// ignore
			}
			this.component = null;
		}
		this.readerHostEl = null;
		this.inlineToolbarEl = null;
		this.inlineToolbarActionsEl = null;
		this.inlineToolbarToggleBtn = null;
		this.inlineSidebarBtn = null;
		this.inlineAutoInsertBtn = null;
		this.inlineFlowBtn = null;
		this.inlineLayoutBtn = null;
		this.inlineReadingReferenceBtn = null;
		this.readingReferenceBtn = null;
		this.readingPositionAutoSaveEnabled = false;
		this.hasReadingReferencePoint = false;
		this.clearHeaderActionRefs();
		if (this.filePath) {
			getBookSessionManager(this.app).releaseIfNoOpenLeaves(this.app, this.filePath);
		}
		this.disposeReaderKeymapScope();
		await super.onClose();
	}

	private setupLinkedTabTracking(): void {
		this.layoutChangeHandler = () => {
			this.applySurfaceContext();
			if (this.toolbarHandlersReady) {
				this.refreshAllActionButtons();
			}
		};
		this.app.workspace.on("layout-change", this.layoutChangeHandler);
	}

	private setupLeafChangeTracking(): void {
		this.leafChangeHandler = (leaf: WorkspaceLeaf | null) => {
			if (leaf && leaf.view instanceof MarkdownView) {
				this.lastActiveMarkdownLeaf = leaf;
			}
		};
		this.app.workspace.on("active-leaf-change", this.leafChangeHandler);

		const currentLeaves = this.app.workspace.getLeavesOfType("markdown");
		if (currentLeaves.length > 0) {
			this.lastActiveMarkdownLeaf = currentLeaves[0];
		}
	}

	private getValidMarkdownLeaf(): WorkspaceLeaf | null {
		if (this.lastActiveMarkdownLeaf) {
			try {
				const view = this.lastActiveMarkdownLeaf.view;
				if (view instanceof MarkdownView && view.editor) {
					return this.lastActiveMarkdownLeaf;
				}
			} catch {
				// stale reference
			}
		}

		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView && leaf.view.editor) {
				this.lastActiveMarkdownLeaf = leaf;
				return leaf;
			}
		}
		return null;
	}

	private async switchBookInCurrentLeaf(newFilePath: string): Promise<void> {
		if (!newFilePath) {
			return;
		}

		if (newFilePath === this.filePath && this.component) {
			void this.app.workspace.revealLeaf(this.leaf);
			return;
		}

		this.bookTitle = "";
		this.chapterTitle = "";
		this.pendingCfi = "";
		this.pendingText = "";
		await this.leaf.setViewState({
			type: VIEW_TYPE_EPUB,
			active: true,
			state: { filePath: newFilePath },
		});
		void this.app.workspace.revealLeaf(this.leaf);
	}

	private async returnFromBookshelfToRecentBook(): Promise<void> {
		const recentPath = await resolveRecentEpubPath(this.app);
		if (!recentPath) {
			new Notice('暂无最近打开的 EPUB');
			return;
		}

		await this.switchBookInCurrentLeaf(recentPath);
	}

	public updateBookTitle(title: string): void {
		this.bookTitle = title;
		this.refreshViewTitle();
	}

	private toggleFlowMode(): void {
		this.flowMode = this.flowMode === "scrolled" ? "paginated" : "scrolled";
		if (this.flowMode === "scrolled") {
			this.layoutMode = "paginated";
		}
		this.updateFlowBtn();
		this.updateLayoutBtn();
		this.actionHandlers.setFlowMode?.(this.flowMode);
	}

	private cycleLayoutMode(): void {
		if (Platform.isMobile) {
			this.layoutMode = "paginated";
			this.actionHandlers.setLayoutMode?.("paginated");
			return;
		}
		if (this.flowMode === "scrolled") {
			this.flowMode = "paginated";
			this.updateFlowBtn();
		}
		const modes: EpubLayoutMode[] = ["paginated", "double"];
		const idx = modes.indexOf(this.layoutMode);
		this.layoutMode = modes[(idx + 1) % modes.length];
		this.updateLayoutBtn();
		this.actionHandlers.setLayoutMode?.(this.layoutMode);
	}

	private updateFlowBtn(): void {
		const icon = this.flowMode === "scrolled" ? "scroll-text" : "arrow-up-down";
		const label = `阅读模式：${this.flowMode === "scrolled" ? '连续滚动' : '翻页'}`;
		this.applyActionButtonState(this.flowBtn, {
			icon,
			label,
			active: this.flowMode === "scrolled",
		});
		this.applyActionButtonState(this.inlineFlowBtn, {
			icon,
			label,
			active: this.flowMode === "scrolled",
		});
	}

	private updateLayoutBtn(): void {
		const iconMap: Record<EpubLayoutMode, string> = {
			paginated: "file-text",
			double: "book-open",
		};
		const layoutLabels: Record<EpubLayoutMode, string> = {
			paginated: '单栏',
			double: '双栏',
		};
		const label = `布局：${layoutLabels[this.layoutMode]}`;
		const icon = iconMap[this.layoutMode];
		this.applyActionButtonState(this.layoutBtn, {
			icon,
			label,
			active: this.layoutMode === "double",
		});
		this.applyActionButtonState(this.inlineLayoutBtn, {
			icon,
			label,
			active: this.layoutMode === "double",
		});
	}

	private updateAutoInsertBtn(): void {
		const label = Platform.isMobile
			? '自动化'
			: this.autoInsertEnabled
				? '自动模式（开：插入）'
				: '自动模式（关：复制，开：插入）';
		const visible = this.shouldShowToolbarFeature();
		this.applyActionButtonState(this.autoInsertBtn, {
			label,
			active: this.canUseExcerptNotes() ? this.autoInsertEnabled : false,
			visible,
		});
		this.applyActionButtonState(this.inlineAutoInsertBtn, {
			label,
			active: this.canUseExcerptNotes() ? this.autoInsertEnabled : false,
			visible,
		});
	}

	private getReadingPositionAutoSaveStateLabel(): string {
		return this.readingPositionAutoSaveEnabled
			? '开'
			: '关';
	}

	private getReadingPositionActionLabel(): string {
		if (!this.canUseReadingReference()) {
			return this.getReadingPositionAutoSaveStateLabel();
		}
		return this.hasReadingReferencePoint
			? '阅读位置已记录'
			: '阅读位置';
	}

	private getReadingPositionActionTooltip(): string {
		const autoSave = this.getReadingPositionAutoSaveStateLabel();
		if (!this.canUseReadingReference()) {
			return `阅读位置 · 连续阅读自动更新：${autoSave}`;
		}
		if (this.hasReadingReferencePoint) {
			return `${'阅读位置已记录'} · 连续阅读自动更新：${autoSave}`;
		}
		return `阅读位置 · 连续阅读自动更新：${autoSave}`;
	}

	private openReadingPositionMenu(evt: MouseEvent | Event): void {
		if (this.actionHandlers.openReadingPositionMenu) {
			this.actionHandlers.openReadingPositionMenu(evt as MouseEvent | KeyboardEvent);
			return;
		}
		void this.actionHandlers.saveReadingReferencePoint?.();
	}

	private updateReadingReferencePointBtn(): void {
		if (this.actionHandlers.getReadingPositionAutoSaveEnabled) {
			this.readingPositionAutoSaveEnabled = this.actionHandlers.getReadingPositionAutoSaveEnabled();
		}
		const label = this.getReadingPositionActionTooltip();
		const shortLabel = this.getReadingPositionActionLabel();
		const visible =
			this.canUseReadingProgress()
			|| this.canUseReadingReference()
			|| this.shouldShowToolbarFeature();
		const active = this.canUseReadingReference() ? this.hasReadingReferencePoint : false;
		this.applyActionButtonState(this.readingReferenceBtn, {
			icon: "flag",
			label,
			active,
			visible,
		});
		if (this.readingReferenceBtn) {
			this.readingReferenceBtn.setAttribute("aria-label", shortLabel);
		}
		this.applyActionButtonState(this.inlineReadingReferenceBtn, {
			icon: "flag",
			label,
			active,
			visible,
		});
		if (this.inlineReadingReferenceBtn) {
			this.inlineReadingReferenceBtn.setAttribute("aria-label", shortLabel);
		}
	}
}
