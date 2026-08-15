import {
	ItemView,
	type KeymapEventHandler,
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Scope,
	TFile,
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
import type { EpubCanvasService } from "../services/epub/EpubCanvasService";
import { reportEpubError } from "../services/epub/epub-error";
import type { CanvasLayoutDirection } from "../services/epub/canvas-types";
import { resolveRecentEpubPath } from "../utils/epub-leaf-utils";
import {
	pendingLocateFromLegacyState,
	type PendingLocateState,
} from "../services/navigation/navigation-intent";
import type { CanvasViewLike, WorkspaceLeafWithGroup } from "../types/obsidian-extensions";
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
	private screenshotModeActive = false;
	private screenshotSaveAsImage = true;
	private layoutMode: EpubLayoutMode = "paginated";
	private flowMode: EpubFlowMode = "paginated";
	private paragraphModeEnabled = false;
	private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;
	private leafChangeHandler: unknown = null;
	private layoutChangeHandler: unknown = null;
	private linkedCanvasPath: string | null = null;
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
	private screenshotBtn: HTMLElement | null = null;
	private inlineScreenshotBtn: HTMLButtonElement | null = null;
	private saveAsImageBtn: HTMLElement | null = null;
	private inlineSaveAsImageBtn: HTMLButtonElement | null = null;
	private flowBtn: HTMLElement | null = null;
	private inlineFlowBtn: HTMLButtonElement | null = null;
	private layoutBtn: HTMLElement | null = null;
	private inlineLayoutBtn: HTMLButtonElement | null = null;
	private paragraphModeBtn: HTMLElement | null = null;
	private inlineParagraphModeBtn: HTMLButtonElement | null = null;
	private canvasBtn: HTMLElement | null = null;
	private inlineCanvasBtn: HTMLButtonElement | null = null;
	private canvasDirBtn: HTMLElement | null = null;
	private inlineCanvasDirBtn: HTMLButtonElement | null = null;
	private canvasModeActive = false;
	private canvasDirection: CanvasLayoutDirection = "down";
	private readingReferenceBtn: HTMLElement | null = null;
	private inlineReadingReferenceBtn: HTMLButtonElement | null = null;
	private hasReadingReferencePoint = false;
	private bookmarkBtn: HTMLElement | null = null;
	private readingPositionAutoSaveEnabled = false;
	private toolbarHandlersReady = false;
	private readerKeymapHandlers: KeymapEventHandler[] = [];
	private actionHandlers: {
		setAutoInsert?: (enabled: boolean) => void;
		setScreenshotMode?: (active: boolean) => void;
		setLayoutMode?: (mode: EpubLayoutMode) => void;
		setFlowMode?: (mode: EpubFlowMode) => void;
		toggleParagraphMode?: () => void;
		openTypographyPanel?: () => void;
		getReaderSettings?: () => EpubReaderSettings;
		updateReaderSettings?: (patch: Partial<EpubReaderSettings>) => Promise<void>;
		setScreenshotSaveMode?: (saveAsImage: boolean) => void;
		navigateToCfi?: (cfi: string, linkTextHint?: string) => void;
		addBookmark?: () => Promise<void>;
		canUseReadingProgress?: () => boolean;
		canUseReadingReference?: () => boolean;
		canUseParagraphMode?: () => boolean;
		canUseExcerptNotes?: () => boolean;
		canUseStyledExcerpts?: () => boolean;
		canUseCanvasExcerpts?: () => boolean;
		canUseFootnotePreview?: () => boolean;
		saveReadingReferencePoint?: () => Promise<void>;
		openReadingPositionMenu?: (event: MouseEvent | KeyboardEvent) => void;
		getReadingPositionAutoSaveEnabled?: () => boolean;
		setReadingPositionAutoSaveEnabled?: (enabled: boolean) => Promise<boolean>;
		bindCanvasPath?: (canvasPath: string) => void;
		unbindCanvas?: () => void;
		getCanvasService?: () => EpubCanvasService;
		getExcerptSettings?: () => EpubExcerptSettings;
		updateExcerptSettings?: (patch: Partial<EpubExcerptSettings>) => Promise<void>;
		prevPage?: () => void | Promise<void>;
		nextPage?: () => void | Promise<void>;
	} = {};

	constructor(leaf: WorkspaceLeaf, plugin: EpubViewHost) {
		super(leaf);
		this.plugin = plugin;
	}

	private getCanvasDirectionLabel(direction: CanvasLayoutDirection): string {
		const directionLabels: Record<CanvasLayoutDirection, string> = {
			down: "向下",
			right: "向右",
			up: "向上",
			left: "向左",
		};
		return directionLabels[direction];
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
			paragraphModeEnabled: this.paragraphModeEnabled,
			screenshotModeActive: this.screenshotModeActive,
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

	private canUseParagraphMode(): boolean {
		return Boolean(this.actionHandlers.canUseParagraphMode?.());
	}

	private canUseExcerptNotes(): boolean {
		return Boolean(this.actionHandlers.canUseExcerptNotes?.());
	}

	private canUseStyledExcerpts(): boolean {
		return Boolean(this.actionHandlers.canUseStyledExcerpts?.());
	}

	private canUseCanvasExcerpts(): boolean {
		return Boolean(this.actionHandlers.canUseCanvasExcerpts?.());
	}

	private canUseFootnotePreview(): boolean {
		return Boolean(this.actionHandlers.canUseFootnotePreview?.());
	}

	private shouldShowToolbarFeature(): boolean {
		return true;
	}

	private areHeaderActionsMounted(): boolean {
		return Boolean(this.autoInsertBtn?.isConnected);
	}

	private clearHeaderActionRefs(): void {
		this.sidebarBtn = null;
		this.saveAsImageBtn = null;
		this.screenshotBtn = null;
		this.autoInsertBtn = null;
		this.bookmarkBtn = null;
		this.readingReferenceBtn = null;
		this.flowBtn = null;
		this.layoutBtn = null;
		this.paragraphModeBtn = null;
		this.canvasDirBtn = null;
		this.canvasBtn = null;
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
			this.screenshotBtn = this.addAction(
				"camera",
				'截图工具',
				() => {
					this.screenshotModeActive = !this.screenshotModeActive;
					this.updateScreenshotBtn();
					this.actionHandlers.setScreenshotMode?.(this.screenshotModeActive);
				}
			);
			this.saveAsImageBtn = this.addAction(
				"image",
				'截图保存为图片',
				() => {
					this.screenshotSaveAsImage = !this.screenshotSaveAsImage;
					this.updateSaveAsImageBtn();
					this.actionHandlers.setScreenshotSaveMode?.(this.screenshotSaveAsImage);
				}
			);
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
			this.paragraphModeBtn = this.addAction(
				"pilcrow",
				'段落模式（关）',
				() => {
					this.toggleParagraphMode();
				}
			);
			this.canvasDirBtn = this.addAction(
				"arrow-down",
				`Canvas 方向：${this.getCanvasDirectionLabel("down")}`,
				(evt) => {
					this.showDirectionMenu(evt);
				}
			);
			this.canvasBtn = this.addAction(
				"layout-dashboard",
				'Canvas 脑图（关）',
				(evt) => {
					this.showCanvasMenu(evt);
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

		this.appendCanvasPaneMenu(menu);

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

	private dismissPaneMenu(menu: Menu): void {
		menu.hide();
		if (typeof menu.close === "function") {
			menu.close();
		}
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

			if (this.actionHandlers.toggleParagraphMode) {
				subMenu.addItem((item) => {
					item.setTitle('段落模式');
					item.setIcon("pilcrow");
					item.setChecked(this.canUseParagraphMode() && this.paragraphModeEnabled);
					item.onClick(() => {
						this.toggleParagraphMode();
					});
				});
			}

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

			if (readerSettings.paragraphModeEnabled) {
				subMenu.addItem((item) => {
					item.setTitle('段落界面风格');
					item.setIcon("panel-top-open");
					const surfaceMenu = this.resolveMenuSubmenu(item, subMenu);

					surfaceMenu.addItem((subItem) => {
						subItem.setTitle('聚焦光晕');
						subItem.setChecked(readerSettings.paragraphModeSurfaceStyle === "spotlight");
						subItem.onClick(() => {
							void this.actionHandlers.updateReaderSettings?.({
								paragraphModeSurfaceStyle: "spotlight",
							});
						});
					});

					surfaceMenu.addItem((subItem) => {
						subItem.setTitle('融入背景');
						subItem.setChecked(readerSettings.paragraphModeSurfaceStyle === "blend");
						subItem.onClick(() => {
							void this.actionHandlers.updateReaderSettings?.({
								paragraphModeSurfaceStyle: "blend",
							});
						});
					});

					surfaceMenu.addItem((subItem) => {
						subItem.setTitle('虚线边框');
						subItem.setChecked(readerSettings.paragraphModeSurfaceStyle === "dashed");
						subItem.onClick(() => {
							void this.actionHandlers.updateReaderSettings?.({
								paragraphModeSurfaceStyle: "dashed",
							});
						});
					});
				});

				subMenu.addItem((item) => {
					item.setTitle('段落切换效果');
					item.setIcon("refresh-cw");
					const transitionMenu = this.resolveMenuSubmenu(item, subMenu);
					const transitionOptions = [
						["steady", '静稳'],
						["fade", '淡隐'],
						["settle", '轻落'],
						["slide", '水平滑页'],
					] as const;

					for (const [value, label] of transitionOptions) {
						transitionMenu.addItem((subItem) => {
							subItem.setTitle(label);
							subItem.setChecked(readerSettings.paragraphModeTransitionStyle === value);
							subItem.onClick(() => {
								void this.actionHandlers.updateReaderSettings?.({
									paragraphModeTransitionStyle: value,
								});
							});
						});
					}
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

		excerptToolsMenu.addItem((subItem) => {
			subItem.setTitle(
				'截图工具'
			);
			subItem.setIcon("camera");
			subItem.setChecked(this.canUseExcerptNotes() ? this.screenshotModeActive : false);
			subItem.onClick(() => {
				this.screenshotModeActive = !this.screenshotModeActive;
				this.updateScreenshotBtn();
				this.actionHandlers.setScreenshotMode?.(this.screenshotModeActive);
			});
		});

		excerptToolsMenu.addItem((subItem) => {
			subItem.setTitle(
				'截图保存为图片'
			);
			subItem.setIcon(this.screenshotSaveAsImage ? "image" : "code");
			subItem.setChecked(this.canUseExcerptNotes() ? this.screenshotSaveAsImage : false);
			subItem.onClick(() => {
				this.screenshotSaveAsImage = !this.screenshotSaveAsImage;
				this.updateSaveAsImageBtn();
				this.actionHandlers.setScreenshotSaveMode?.(this.screenshotSaveAsImage);
			});
		});
	}

	private populateExcerptNotesSettings(subMenu: Menu, excerptSettings: EpubExcerptSettings): void {
		if (this.canUseExcerptNotes()) {
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

	private appendCanvasPaneMenu(menu: Menu): void {
		if (!this.shouldShowToolbarFeature()) {
			return;
		}

		if (this.canUseCanvasExcerpts()) {
			menu.addItem((item) => {
				item.setTitle(
					this.canvasModeActive
						? 'Canvas 脑图（开）'
						: 'Canvas 脑图（关）'
				);
				item.setIcon("layout-dashboard");
				item.setChecked(this.canvasModeActive);
				item.onClick((evt) => {
					this.dismissPaneMenu(menu);
					window.setTimeout(() => {
						this.showCanvasMenu(evt);
					}, 0);
				});
			});
			return;
		}


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
		this.inlineSaveAsImageBtn = this.appendInlineActionButton(
			"image",
			'保存为图片文件（开）',
			() => {
				this.screenshotSaveAsImage = !this.screenshotSaveAsImage;
				this.updateSaveAsImageBtn();
				this.actionHandlers.setScreenshotSaveMode?.(this.screenshotSaveAsImage);
			}
		);
		this.inlineScreenshotBtn = this.appendInlineActionButton(
			"camera",
			'截图工具（关）',
			() => {
				this.screenshotModeActive = !this.screenshotModeActive;
				this.updateScreenshotBtn();
				this.actionHandlers.setScreenshotMode?.(this.screenshotModeActive);
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
		this.inlineParagraphModeBtn = this.appendInlineActionButton(
			"pilcrow",
			'段落模式（关）',
			() => {
				this.toggleParagraphMode();
			}
		);
		this.inlineCanvasDirBtn = this.appendInlineActionButton(
			"arrow-down",
			`Canvas 方向：${this.getCanvasDirectionLabel("down")}`,
			(evt) => {
				this.showDirectionMenu(evt);
			}
		);
		this.inlineCanvasBtn = this.appendInlineActionButton(
			"layout-dashboard",
			'Canvas 脑图（关）',
			(evt) => {
				this.showCanvasMenu(evt);
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
		this.updateSaveAsImageBtn();
		this.updateScreenshotBtn();
		this.updateAutoInsertBtn();
		this.updateReadingReferencePointBtn();
		this.updateFlowBtn();
		this.updateLayoutBtn();
		this.updateParagraphModeBtn();
		this.updateCanvasBtn();
		this.updateDirectionBtn();
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
				paragraphModeEnabled?: boolean;
			}) => {
				this.layoutMode = settings.layoutMode;
				this.flowMode = settings.flowMode;
				this.paragraphModeEnabled = Boolean(settings.paragraphModeEnabled);
				this.updateFlowBtn();
				this.updateLayoutBtn();
				this.updateParagraphModeBtn();
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
					this.paragraphModeEnabled = Boolean(readerSettings.paragraphModeEnabled);
				}
				this.syncToolbarAfterActionsReady();
			},
			onSwitchBook: async (newFilePath: string) => {
				await this.switchBookInCurrentLeaf(newFilePath);
			},
			onCanvasStateChange: (active: boolean, _canvasPath: string | null) => {
				this.canvasModeActive = active;
				this.updateCanvasBtn();
				if (active) {
					const canvasService = this.actionHandlers.getCanvasService?.();
					if (canvasService) {
						this.canvasDirection = canvasService.getLayoutDirection();
						this.updateDirectionBtn();
					}
				}
			},
			onCanvasLayoutDirectionChange: (direction: CanvasLayoutDirection) => {
				this.canvasDirection = direction;
				this.updateDirectionBtn();
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
		this.inlineSaveAsImageBtn = null;
		this.inlineScreenshotBtn = null;
		this.inlineAutoInsertBtn = null;
		this.inlineFlowBtn = null;
		this.inlineLayoutBtn = null;
		this.inlineCanvasDirBtn = null;
		this.inlineCanvasBtn = null;
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
			this.checkLinkedCanvasTab();
			if (this.toolbarHandlersReady) {
				this.refreshAllActionButtons();
			}
		};
		this.app.workspace.on("layout-change", this.layoutChangeHandler);
	}

	private checkLinkedCanvasTab(): void {
		if (!this.canUseCanvasExcerpts()) {
			if (this.linkedCanvasPath || this.canvasModeActive) {
				this.linkedCanvasPath = null;
				this.canvasModeActive = false;
				this.actionHandlers.unbindCanvas?.();
				this.updateCanvasBtn();
			}
			return;
		}

		const myGroup = (this.leaf as WorkspaceLeafWithGroup).group;

		if (!myGroup) {
			if (this.linkedCanvasPath) {
				this.linkedCanvasPath = null;
				this.canvasModeActive = false;
				this.actionHandlers.unbindCanvas?.();
				this.updateCanvasBtn();
			}
			return;
		}

		const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
		let foundCanvasPath: string | null = null;

		for (const leaf of canvasLeaves) {
			if ((leaf as WorkspaceLeafWithGroup).group === myGroup) {
				const file = (leaf.view as CanvasViewLike).file;
				if (file?.path) {
					foundCanvasPath = file.path;
					break;
				}
			}
		}

		if (foundCanvasPath && foundCanvasPath !== this.linkedCanvasPath) {
			this.linkedCanvasPath = foundCanvasPath;
			this.canvasModeActive = true;
			this.actionHandlers.bindCanvasPath?.(foundCanvasPath);
			this.updateCanvasBtn();
			new Notice(
				`Canvas 已关联：${foundCanvasPath.split("/").pop() || foundCanvasPath}`
			);
		} else if (!foundCanvasPath && this.linkedCanvasPath) {
			this.linkedCanvasPath = null;
			this.canvasModeActive = false;
			this.actionHandlers.unbindCanvas?.();
			this.updateCanvasBtn();
			new Notice('Canvas 已取消关联');
		}
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

	private toggleParagraphMode(): void {
		this.paragraphModeEnabled = !this.paragraphModeEnabled;
		this.updateParagraphModeBtn();
		this.actionHandlers.toggleParagraphMode?.();
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

	private updateParagraphModeBtn(): void {
		const canUseParagraphMode = this.canUseParagraphMode();
		const visible = this.shouldShowToolbarFeature();
		const baseLabel = this.paragraphModeEnabled
			? '段落模式（开）'
			: '段落模式（关）';
		const label = baseLabel;
		this.applyActionButtonState(this.paragraphModeBtn, {
			icon: "pilcrow",
			label,
			active: canUseParagraphMode ? this.paragraphModeEnabled : false,
			visible,
		});
		this.applyActionButtonState(this.inlineParagraphModeBtn, {
			icon: "pilcrow",
			label,
			active: canUseParagraphMode ? this.paragraphModeEnabled : false,
			visible,
		});
	}

	private updateSaveAsImageBtn(): void {
		const icon = this.screenshotSaveAsImage ? "image" : "code";
		const label = Platform.isMobile
			? '截图保存为图片'
			: this.screenshotSaveAsImage
				? '保存为图片文件（开）'
				: '保存为嵌入链接（关）';
		const visible = this.shouldShowToolbarFeature();
		this.applyActionButtonState(this.saveAsImageBtn, {
			icon,
			label,
			active: this.canUseExcerptNotes() ? this.screenshotSaveAsImage : false,
			visible,
		});
		this.applyActionButtonState(this.inlineSaveAsImageBtn, {
			icon,
			label,
			active: this.canUseExcerptNotes() ? this.screenshotSaveAsImage : false,
			visible,
		});
	}

	private updateScreenshotBtn(): void {
		const label = Platform.isMobile
			? '截图工具'
			: this.screenshotModeActive
				? '截图工具（开）'
				: '截图工具（关）';
		const visible = this.shouldShowToolbarFeature();
		this.applyActionButtonState(this.screenshotBtn, {
			label,
			active: this.canUseExcerptNotes() ? this.screenshotModeActive : false,
			visible,
		});
		this.applyActionButtonState(this.inlineScreenshotBtn, {
			label,
			active: this.canUseExcerptNotes() ? this.screenshotModeActive : false,
			visible,
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

	private updateCanvasBtn(): void {
		const label = this.canvasModeActive
			? 'Canvas 脑图（开）'
			: 'Canvas 脑图（关）';
		const visible = this.shouldShowToolbarFeature();
		this.applyActionButtonState(this.canvasBtn, {
			icon: "layout-dashboard",
			label,
			active: this.canvasModeActive,
			visible,
		});
		this.applyActionButtonState(this.inlineCanvasBtn, {
			icon: "layout-dashboard",
			label,
			active: this.canvasModeActive,
			visible,
		});
		this.applyActionButtonState(this.canvasDirBtn, {
			visible: visible && this.canvasModeActive,
		});
		this.applyActionButtonState(this.inlineCanvasDirBtn, {
			visible: visible && this.canvasModeActive,
		});
	}

	private showDirectionMenu(evt: MouseEvent | Event): void {
		const canvasService = this.actionHandlers.getCanvasService?.();
		if (!canvasService) return;

		const menu = new Menu();
		const dirs: { dir: CanvasLayoutDirection; icon: string; label: string }[] = [
			{ dir: "down", icon: "arrow-down", label: this.getCanvasDirectionLabel("down") },
			{ dir: "right", icon: "arrow-right", label: this.getCanvasDirectionLabel("right") },
			{ dir: "up", icon: "arrow-up", label: this.getCanvasDirectionLabel("up") },
			{ dir: "left", icon: "arrow-left", label: this.getCanvasDirectionLabel("left") },
		];

		for (const { dir, icon, label } of dirs) {
			menu.addItem((_item) => {
				_item.setTitle(label);
				_item.setIcon(icon);
				_item.setChecked(this.canvasDirection === dir);
				_item.onClick(() => {
					this.canvasDirection = dir;
					canvasService.setLayoutDirection(dir);
					this.updateDirectionBtn();
				});
			});
		}

		menu.showAtMouseEvent(evt as MouseEvent);
	}

	private updateDirectionBtn(): void {
		const iconMap: Record<CanvasLayoutDirection, string> = {
			down: "arrow-down",
			right: "arrow-right",
			up: "arrow-up",
			left: "arrow-left",
		};
		const label = `Canvas 方向：${this.getCanvasDirectionLabel(this.canvasDirection)}`;
		const icon = iconMap[this.canvasDirection];
		this.applyActionButtonState(this.canvasDirBtn, {
			icon,
			label,
			visible: this.canvasModeActive,
		});
		this.applyActionButtonState(this.inlineCanvasDirBtn, {
			icon,
			label,
			visible: this.canvasModeActive,
		});
	}

	private showCanvasMenu(evt: MouseEvent | Event): void {
		if (!this.canUseCanvasExcerpts()) {
			return;
		}

		const canvasService = this.actionHandlers.getCanvasService?.();
		if (!canvasService) return;

		const menu = new Menu();

		if (this.canvasModeActive) {
			const currentPath = canvasService.getCanvasPath();
			if (currentPath) {
				menu.addItem((_item) => {
					_item.setTitle(`当前：${currentPath}`);
					_item.setIcon("file");
					_item.setDisabled(true);
				});
				menu.addItem((_item) => {
					_item.setTitle('打开 canvas');
					_item.setIcon("external-link");
					_item.onClick(() => this.openCanvasFile(currentPath));
				});
			}
			menu.addSeparator();
			menu.addItem((_item) => {
				_item.setTitle('断开 canvas');
				_item.setIcon("unlink");
				_item.onClick(() => {
					this.canvasModeActive = false;
					this.actionHandlers.unbindCanvas?.();
					this.updateCanvasBtn();
				});
			});
		} else {
			menu.addItem((_item) => {
				_item.setTitle('新建 canvas');
				_item.setIcon("plus");
				_item.onClick(() => this.createAndBindCanvas(canvasService));
			});

			const canvasFiles = this.app.vault
				.getFiles()
				.filter((f) => f.extension === "canvas")
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 15);

			if (canvasFiles.length > 0) {
				menu.addSeparator();
				for (const file of canvasFiles) {
					menu.addItem((_item) => {
						_item.setTitle(file.path);
						_item.setIcon("file");
						_item.onClick(() => this.bindExistingCanvas(canvasService, file.path));
					});
				}
			}
		}

		menu.showAtMouseEvent(evt as MouseEvent);
	}

	private async createAndBindCanvas(canvasService: EpubCanvasService): Promise<void> {
		const title = this.bookTitle || "EPUB";
		const safeName = title
			.replace(/[\\/:*?"<>|]/g, "_")
			.substring(0, 40)
			.trim();
		const canvasPath = `${safeName}-mindmap.canvas`;

		try {
			await canvasService.createCanvas(canvasPath);
			this.canvasModeActive = true;
			this.actionHandlers.bindCanvasPath?.(canvasPath);
			this.updateCanvasBtn();
			new Notice(`Canvas 已创建：${canvasPath}`);

			this.openCanvasFile(canvasPath);
		} catch (e) {
			logger.error("[EpubView] Failed to create canvas:", e);
			new Notice('Canvas 创建失败');
		}
	}

	private async bindExistingCanvas(_canvasService: EpubCanvasService, path: string): Promise<void> {
		try {
			this.canvasModeActive = true;
			this.actionHandlers.bindCanvasPath?.(path);
			this.updateCanvasBtn();
			new Notice(`Canvas 已连接：${path}`);
		} catch (e) {
			logger.error("[EpubView] Failed to bind canvas:", e);
		}
	}

	private openCanvasFile(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf("split", "vertical");
			void leaf.openFile(file);
		}
	}
}
