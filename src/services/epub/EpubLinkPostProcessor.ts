import type { App } from "obsidian";
import { MarkdownPostProcessorContext, setIcon } from "obsidian";
import { isSupportedBookLocatorHref, stripSupportedBookExtension } from "./book-format";
import { EpubLinkService } from "./EpubLinkService";
import { resolveEpubSourceNavigationTextHint } from "./epub-source-navigation-text-hint";
import { isSupportedEpubProtocolName } from "./epub-runtime";
import {
	ExcerptHoverPopoverController,
	bindExcerptHoverPreview,
} from "./excerpt-hover-popover";
import { ExcerptParagraphPreviewService } from "./excerpt-paragraph-preview-service";

type EpubLinkPostProcessorOptions = {
	/** 段落预览浮框总开关（读插件设置，默认开启）。 */
	isHoverPreviewEnabled?: () => boolean;
};

const hoverControllers = new WeakMap<App, ExcerptHoverPopoverController>();
const previewServices = new WeakMap<App, ExcerptParagraphPreviewService>();

/** 插件卸载时释放 hover 浮框与离线解析引擎（避免 blob/内存泄漏）。 */
export function disposeEpubExcerptHoverPreview(app: App): void {
	hoverControllers.get(app)?.hide();
	hoverControllers.delete(app);
	previewServices.get(app)?.dispose();
	previewServices.delete(app);
}

function getHoverController(app: App): ExcerptHoverPopoverController {
	let controller = hoverControllers.get(app);
	if (!controller) {
		controller = new ExcerptHoverPopoverController();
		hoverControllers.set(app, controller);
	}
	return controller;
}

function getPreviewService(app: App): ExcerptParagraphPreviewService {
	let service = previewServices.get(app);
	if (!service) {
		service = new ExcerptParagraphPreviewService(app);
		previewServices.set(app, service);
	}
	return service;
}

/**
 * 合并粘贴块（一个 callout 多条摘录，深链仅首条定位）不可做单段预览：
 * 引用区出现多条非想法（非 💡 开头）的引文段即视为合并形态。
 */
function isMergedExcerptCallout(calloutEl: HTMLElement): boolean {
	const quoteParagraphs = Array.from(
		calloutEl.querySelectorAll<HTMLElement>(".callout-content blockquote p")
	);
	let quoteCount = 0;
	for (const paragraph of quoteParagraphs) {
		if (String(paragraph.textContent || "").trim().startsWith("💡")) {
			continue;
		}
		quoteCount += 1;
		if (quoteCount > 1) {
			return true;
		}
	}
	return false;
}

function bindExcerptCalloutHoverPreview(params: {
	app: App;
	calloutEl: HTMLElement;
	filePath: string;
	cfi: string;
	options: EpubLinkPostProcessorOptions | undefined;
}): void {
	const cfi = String(params.cfi || "").trim();
	if (!cfi) {
		return;
	}
	const calloutEl = params.calloutEl;
	const excerptText = extractCalloutQuoteText(calloutEl);
	const excerptColor = calloutEl.getAttribute("data-weave-epub-color") || "";
	bindExcerptHoverPreview({
		calloutEl,
		controller: getHoverController(params.app),
		isEnabled: () => params.options?.isHoverPreviewEnabled?.() !== false,
		isSupportedBlock: () => !isMergedExcerptCallout(calloutEl),
		excerptColor,
		excerptText,
		loadPreview: () =>
			getPreviewService(params.app).getPreview({
				filePath: params.filePath,
				cfi,
				excerptText,
			}),
	});
}

type BoundEpubLinkElement = HTMLAnchorElement & {
	__weaveEpubClickHandler?: (event: MouseEvent) => void;
	__weaveEpubBoundHref?: string;
};

function extractEpubProtocolName(href: string): string {
	const normalizedHref = String(href || "").trim();
	if (!normalizedHref) {
		return "";
	}

	const withoutScheme = normalizedHref.startsWith("obsidian://")
		? normalizedHref.slice("obsidian://".length)
		: normalizedHref;
	return withoutScheme.split("?")[0]?.trim() || "";
}

function clearBoundEpubHandler(linkEl: BoundEpubLinkElement): void {
	if (linkEl.__weaveEpubClickHandler) {
		linkEl.removeEventListener("click", linkEl.__weaveEpubClickHandler, true);
		linkEl.removeEventListener("click", linkEl.__weaveEpubClickHandler);
		linkEl.__weaveEpubClickHandler = undefined;
	}
	linkEl.__weaveEpubBoundHref = undefined;
}

function collectEpubCalloutElements(root: HTMLElement): HTMLElement[] {
	const results: HTMLElement[] = [];
	if (root.matches('.callout[data-callout="epub"]')) {
		results.push(root);
	}
	results.push(...Array.from(root.querySelectorAll<HTMLElement>('.callout[data-callout="epub"]')));
	return results;
}

function extractCalloutQuoteText(linkEl: HTMLElement): string {
	const callout = linkEl.closest('.callout[data-callout="epub"]');
	if (!callout) {
		return "";
	}

	const quoteLines: string[] = [];
	for (const block of Array.from(callout.querySelectorAll<HTMLElement>(".callout-content blockquote p"))) {
		const text = String(block.textContent || "")
			.replace(/\s+/g, " ")
			.trim();
		if (text) {
			quoteLines.push(text);
		}
	}

	if (quoteLines.length > 0) {
		return quoteLines.join("\n");
	}

	const content = callout.querySelector(".callout-content");
	if (!content) {
		return "";
	}

	return String(content.textContent || "")
		.replace(/\s+/g, " ")
		.trim();
}

function applyEpubCalloutAppearanceAttributes(root: HTMLElement): void {
	for (const calloutEl of collectEpubCalloutElements(root)) {
		const metadata = calloutEl.getAttribute("data-callout-metadata") || "";
		const appearance = EpubLinkService.parseHighlightCalloutMeta(metadata);
		const color = appearance.color || "";
		const style = appearance.style || "";

		if (color) {
			calloutEl.setAttribute("data-weave-epub-color", color);
		} else {
			calloutEl.removeAttribute("data-weave-epub-color");
		}

		if (style) {
			calloutEl.setAttribute("data-weave-epub-style", style);
		} else {
			calloutEl.removeAttribute("data-weave-epub-style");
		}
	}
}

function resolveProtocolLocatorHref(href: string): string | null {
	const protocolName = extractEpubProtocolName(href);
	if (!isSupportedEpubProtocolName(protocolName)) {
		return null;
	}

	try {
		const url = new URL(href.startsWith("obsidian://") ? href : `obsidian://${href}`);
		const params = Object.fromEntries(url.searchParams.entries());
		if ((!params.file && !params.sid) || !params.cfi) {
			return null;
		}

		const parsed = EpubLinkService.parseProtocolParams(params);
		if (!parsed?.filePath || !parsed.cfi) {
			return null;
		}

		const locatorHref = EpubLinkService.buildEpubLocatorHref(
			parsed.filePath,
			parsed.cfi,
			parsed.text,
			parsed.chapter,
			parsed.sourceId,
			parsed.excerptId,
			{
				includeText: Boolean(String(parsed.text || "").trim()),
				includeChapter: parsed.chapter !== undefined,
				preferCompactLocator: true,
			}
		);
		return locatorHref && isSupportedBookLocatorHref(locatorHref) ? locatorHref : null;
	} catch {
		return null;
	}
}

function bindEpubLocatorLink(
	app: App,
	linkEl: HTMLAnchorElement,
	locatorHref: string,
	ctx: MarkdownPostProcessorContext,
	displayText?: string,
	options?: EpubLinkPostProcessorOptions
): void {
	const boundLinkEl = linkEl as BoundEpubLinkElement;
	const hashIdx = locatorHref.indexOf("#");
	if (hashIdx === -1) {
		clearBoundEpubHandler(boundLinkEl);
		return;
	}

	const filePath = locatorHref.substring(0, hashIdx);
	const subpath = locatorHref.substring(hashIdx);
	if (!EpubLinkService.hasSupportedEpubSubpath(subpath)) {
		clearBoundEpubHandler(boundLinkEl);
		return;
	}

	const parsed = EpubLinkService.parseEpubLink(subpath);
	if (!parsed) {
		clearBoundEpubHandler(boundLinkEl);
		return;
	}

	if (boundLinkEl.__weaveEpubBoundHref === locatorHref) {
		return;
	}

	clearBoundEpubHandler(boundLinkEl);
	linkEl.setAttribute("href", locatorHref);
	linkEl.addClass("internal-link");
	linkEl.removeClass("external-link");

	styleEpubLink(
		linkEl,
		displayText ||
			linkEl.textContent ||
			stripSupportedBookExtension(filePath.split("/").pop() || "") ||
			"Book"
	);

	boundLinkEl.__weaveEpubBoundHref = locatorHref;
	const navigateFromLink = () => {
		void (async () => {
			const linkService = new EpubLinkService(app);
			const sourceMarkdownPath = String(ctx?.sourcePath || "").trim() || undefined;
			const calloutQuoteText = String(parsed.cfi || "").trim()
				? ""
				: extractCalloutQuoteText(boundLinkEl);
			const quoteText = resolveEpubSourceNavigationTextHint(parsed, calloutQuoteText);
			await linkService.navigateToEpubLocation(
				filePath,
				parsed.cfi,
				quoteText,
				parsed.sourceId,
				sourceMarkdownPath
			);
		})();
	};

	boundLinkEl.__weaveEpubClickHandler = (e: MouseEvent) => {
		e.preventDefault();
		e.stopImmediatePropagation();
		navigateFromLink();
	};
	// Capture phase runs before Obsidian's obsidian:// default handler opens a new tab.
	linkEl.addEventListener("click", boundLinkEl.__weaveEpubClickHandler, true);
	linkEl.addEventListener("click", boundLinkEl.__weaveEpubClickHandler);

	const calloutEl = boundLinkEl.closest<HTMLElement>('.callout[data-callout="epub"]');
	if (calloutEl) {
		bindExcerptCalloutHoverPreview({ app, calloutEl, filePath, cfi: parsed.cfi, options });
	}
}

export function createEpubLinkPostProcessor(app: App, options?: EpubLinkPostProcessorOptions) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		applyEpubCalloutAppearanceAttributes(el);

		const links = el.querySelectorAll("a");

		links.forEach((linkEl) => {
			if (!(linkEl.instanceOf(HTMLAnchorElement))) {
				return;
			}

			const rawHref = linkEl.getAttribute("href") || linkEl.getAttribute("data-href") || "";
			const protocolLocatorHref = resolveProtocolLocatorHref(rawHref);
			const locatorHref = protocolLocatorHref || (isSupportedBookLocatorHref(rawHref) ? rawHref : "");

			if (!locatorHref) {
				clearBoundEpubHandler(linkEl as BoundEpubLinkElement);
				return;
			}

			const displayText = protocolLocatorHref ? linkEl.textContent || undefined : undefined;
			bindEpubLocatorLink(app, linkEl, locatorHref, ctx, displayText, options);
		});
	};
}

function styleEpubLink(linkEl: Element, displayText: string): void {
	linkEl.addClass("weave-epub-link");
	linkEl.removeClass("external-link");
	linkEl.empty();

	const inEpubCalloutTitle = Boolean(
		(linkEl as HTMLElement).closest('.callout[data-callout="epub"] .callout-title')
	);
	if (!inEpubCalloutTitle) {
		const iconSpan = (linkEl as HTMLElement).createSpan({
			cls: "weave-epub-link-icon",
		});
		setIcon(iconSpan, "book-open");
	}

	(linkEl as HTMLElement).createSpan({
		cls: "weave-epub-link-text",
		text: displayText,
	});
}
