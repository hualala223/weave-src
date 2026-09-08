import type { ExcerptParagraphPreview } from "./excerpt-paragraph-preview-service";

const POPOVER_CLASS = "weave-excerpt-paragraph-popover";
const HOVER_DELAY_MS = 300;
const DISMISS_GRACE_MS = 120;
const MAX_WIDTH_PX = 480;

interface PopoverPosition {
	left: number;
	top: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function positionPopover(popover: HTMLElement, anchorRect: DOMRect): void {
	const win = popover.ownerDocument.defaultView || window;
	const viewportWidth = win.innerWidth;
	const viewportHeight = win.innerHeight;
	const margin = 12;
	const gap = 8;
	const popoverRect = popover.getBoundingClientRect();
	const maxHeights = [viewportHeight * 0.5, viewportHeight - margin * 2];
	popover.style.maxHeight = `${Math.floor(Math.max(120, Math.min(...maxHeights)))}px`;

	// 水平：与锚块左对齐，左右越界时收进视口。
	let left = anchorRect.left;
	left = clamp(left, margin, Math.max(margin, viewportWidth - margin - popoverRect.width));

	// 垂直：优先在锚块下方，空间不足翻转到上方；都不足时贴近视口底部。
	let top = anchorRect.bottom + gap;
	if (top + popoverRect.height > viewportHeight - margin) {
		const above = anchorRect.top - gap - popoverRect.height;
		top = above >= margin ? above : viewportHeight - margin - popoverRect.height;
	}
	top = clamp(top, margin, Math.max(margin, viewportHeight - margin - popoverRect.height));

	popover.style.left = `${Math.round(left)}px`;
	popover.style.top = `${Math.round(top)}px`;
}

function buildPopoverContent(contentEl: HTMLElement, preview: ExcerptParagraphPreview, excerptText: string): void {
	contentEl.empty();
	if (preview.status !== "found" || !preview.paragraphText) {
		if (preview.chapterTitle) {
			contentEl.createDiv({ cls: `${POPOVER_CLASS}__chapter`, text: preview.chapterTitle });
		}
		contentEl.createDiv({
			cls: `${POPOVER_CLASS}__missing`,
			text: "无法加载原文段落",
		});
		const fallback = String(excerptText || "").trim();
		if (fallback) {
			contentEl.createDiv({ cls: `${POPOVER_CLASS}__fallback`, text: fallback });
		}
		return;
	}

	if (preview.chapterTitle) {
		contentEl.createDiv({ cls: `${POPOVER_CLASS}__chapter`, text: preview.chapterTitle });
	}

	const paragraphEl = contentEl.createDiv({ cls: `${POPOVER_CLASS}__paragraph` });
	const text = preview.paragraphText;
	const highlight = preview.highlight;
	if (!highlight || highlight.start < 0 || highlight.end <= highlight.start || highlight.end > text.length) {
		paragraphEl.textContent = text;
		return;
	}
	paragraphEl.createSpan({ text: text.slice(0, highlight.start) });
	paragraphEl.createSpan({
		cls: `${POPOVER_CLASS}__highlight`,
		text: text.slice(highlight.start, highlight.end),
	});
	paragraphEl.createSpan({ text: text.slice(highlight.end) });
}

/**
 * 段落预览浮框控制器：单个浮框实例全局复用（body 直挂），
 * 由摘录块 hover 触发；鼠标移出块与浮框后关闭。
 */
export class ExcerptHoverPopoverController {
	private popover: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;
	private hideTimer: number | null = null;
	private hoverTarget: HTMLElement | null = null;

	show(
		target: HTMLElement,
		excerptColor: string,
		loadPreview: (contentEl: HTMLElement) => Promise<ExcerptParagraphPreview>,
		excerptText: string
	): void {
		this.cancelHide();
		const doc = target.ownerDocument;
		if (!doc) {
			return;
		}
		if (!this.popover) {
			this.popover = doc.body.createDiv({ cls: POPOVER_CLASS });
			this.contentEl = this.popover.createDiv({ cls: `${POPOVER_CLASS}__content` });
			this.popover.addEventListener("mouseenter", () => this.cancelHide());
			this.popover.addEventListener("mouseleave", () => this.scheduleHide());
		} else if (this.popover.ownerDocument === doc) {
			doc.body.appendChild(this.popover);
		}
		this.hoverTarget = target;
		this.popover.style.visibility = "hidden";
		if (excerptColor) {
			this.popover.setAttribute("data-weave-epub-color", excerptColor);
		} else {
			this.popover.removeAttribute("data-weave-epub-color");
		}

		const contentEl = this.contentEl;
		if (!contentEl) {
			return;
		}
		contentEl.empty();
		contentEl.createDiv({ cls: `${POPOVER_CLASS}__loading`, text: "正在加载原文段落…" });

		const targetForThisShow = target;
		void loadPreview(contentEl)
			.then((preview) => {
				if (this.hoverTarget !== targetForThisShow || !this.popover) {
					return;
				}
				buildPopoverContent(contentEl, preview, excerptText);
				this.popover.style.visibility = "";
				positionPopover(this.popover, targetForThisShow.getBoundingClientRect());
			})
			.catch(() => {
				if (this.hoverTarget !== targetForThisShow || !this.popover) {
					return;
				}
				buildPopoverContent(
					contentEl,
					{ status: "unavailable", chapterTitle: "", paragraphText: "", highlight: null },
					excerptText
				);
				this.popover.style.visibility = "";
				positionPopover(this.popover, targetForThisShow.getBoundingClientRect());
			});
	}

	/** 鼠标离开摘录块：宽限期内进入浮框则保持显示，否则关闭。 */
	scheduleHide(): void {
		this.cancelHide();
		this.hideTimer = window.setTimeout(() => this.hide(), DISMISS_GRACE_MS);
	}

	cancelHide(): void {
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
	}

	hide(): void {
		this.cancelHide();
		this.hoverTarget = null;
		if (this.popover) {
			this.popover.detach();
			this.popover = null;
			this.contentEl = null;
		}
	}
}

/** 摘录块 hover 绑定：进入块延迟弹浮框，Ctrl+进入立即弹；离开块/浮框关闭。 */
export function bindExcerptHoverPreview(options: {
	calloutEl: HTMLElement;
	controller: ExcerptHoverPopoverController;
	isEnabled: () => boolean;
	isSupportedBlock: () => boolean;
	excerptColor: string;
	excerptText: string;
	loadPreview: () => Promise<ExcerptParagraphPreview>;
}): void {
	const calloutEl = options.calloutEl as ExcerptHoverBoundElement;
	if (calloutEl.__weaveExcerptHoverBound) {
		return;
	}
	calloutEl.__weaveExcerptHoverBound = true;

	let enterTimer: number | null = null;
	const cancelEnter = () => {
		if (enterTimer !== null) {
			window.clearTimeout(enterTimer);
			enterTimer = null;
		}
	};

	calloutEl.addEventListener("mouseenter", (event: MouseEvent) => {
		if (!options.isEnabled() || !options.isSupportedBlock()) {
			return;
		}
		const withCtrl = Boolean(event.ctrlKey);
		cancelEnter();
		enterTimer = window.setTimeout(
			() => {
				enterTimer = null;
				options.controller.show(
					calloutEl,
					options.excerptColor,
					async () => options.loadPreview(),
					options.excerptText
				);
			},
			withCtrl ? 0 : HOVER_DELAY_MS
		);
	});
	calloutEl.addEventListener("mouseleave", () => {
		cancelEnter();
		options.controller.scheduleHide();
	});
}

type ExcerptHoverBoundElement = HTMLElement & {
	__weaveExcerptHoverBound?: boolean;
};
