import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const foliateRoot = path.resolve(__dirname, "../node_modules/foliate-js");
const paginatorPath = path.join(foliateRoot, "paginator.js");
const viewPath = path.join(foliateRoot, "view.js");
const fixedLayoutPath = path.join(foliateRoot, "fixed-layout.js");
const epubPath = path.join(foliateRoot, "epub.js");
const GROUPBY_POLYFILL_MARKER = "weave-epub-reader Object.groupBy polyfill";
const SCROLLED_RENDER_GUARD_MARKER = "weave-epub-reader scrolled render guards";
const MOBILE_SELECTION_GUARD_MARKER = "weave-epub-reader mobile selection guard";
const TOUCH_END_SELECTION_GUARD_MARKER = "weave-epub-reader touchend selection guard";
const EXPAND_SELECTION_GUARD_MARKER = "weave-epub-reader expand selection guard";
const SELECTION_SCROLL_FREEZE_MARKER = "weave-epub-reader selection scroll freeze";
const VIEW_RELOCATE_REASON_MARKER = "weave-epub-reader relocate reason passthrough";

const SCROLLED_RENDER_GUARD_PATCHES = [
	{
		oldText: `const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}`,
		newText: `// ${SCROLLED_RENDER_GUARD_MARKER}
const setStylesImportant = (el, styles) => {
    if (!el?.style) return
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}`,
	},
	{
		oldText: `    render(layout) {
        if (!layout || !this.document) return
        this.#column = layout.flow !== 'scrolled'`,
		newText: `    render(layout) {
        const doc = this.document
        if (!layout || !doc?.documentElement || !doc.body) return
        this.#column = layout.flow !== 'scrolled'`,
	},
	{
		oldText: `    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {`,
		newText: `    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        if (!doc?.documentElement || !doc.body) return
        setStylesImportant(doc.documentElement, {`,
	},
	{
		oldText: `    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {`,
		newText: `    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        if (!doc?.documentElement || !doc.body) return
        setStylesImportant(doc.documentElement, {`,
	},
	{
		oldText: `    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {`,
		newText: `    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        if (!doc?.body) return
        for (const el of doc.body.querySelectorAll('img, svg, video')) {`,
	},
	{
		oldText: `    expand() {
        const { documentElement } = this.document
        if (this.#column) {`,
		newText: `    expand() {
        const doc = this.document
        if (!doc?.documentElement) return
        const { documentElement } = doc
        if (this.#column) {`,
	},
	{
		oldText: `    render() {
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }`,
		newText: `    render() {
        if (!this.#view) return
        const { width, height } = this.#container.getBoundingClientRect()
        if (width <= 0 || height <= 0) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }`,
	},
];

const OLD_SET_SELECTION = `const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        if (collapse === -1) range.collapse(true)
        else if (collapse === 1) range.collapse()
        sel.addRange(range)
    }
}`;

const NEW_SET_SELECTION = `const isLiveSelectionTarget = (target, doc) => {
    if (!doc || target == null) return false
    if (typeof target === 'number') return true
    const node = target.startContainer ?? target
    if (!node) return false
    return doc.contains(node)
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target?.startContainer) range = target.cloneRange()
    else if (target?.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (!range) return
    const view = range.startContainer?.ownerDocument?.defaultView
    const selection = view?.getSelection?.()
    if (!selection) return
    selection.removeAllRanges()
    if (collapse === -1) range.collapse(true)
    else if (collapse === 1) range.collapse()
    selection.addRange(range)
}`;

const OLD_RELOCATE = `        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })`;

const NEW_RELOCATE = `        this.addEventListener('relocate', ({ detail }) => {
            const liveDoc = this.#view?.document
            if (detail.reason === 'selection') {
                if (isLiveSelectionTarget(this.#anchor, liveDoc)) setSelectionTo(this.#anchor, 0)
            } else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number') setSelectionTo(detail.range, -1)
                else if (isLiveSelectionTarget(this.#anchor, liveDoc)) setSelectionTo(this.#anchor, -1)
                else if (detail.range) setSelectionTo(detail.range, -1)
            }
        })`;

const SANDBOX_PATCHES = [
	{
		file: paginatorPath,
		oldText: `        // \`allow-scripts\` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')`,
		newText: `        // Weave omits iframe sandbox: EPUB markup is sanitized before load.`,
	},
	{
		file: fixedLayoutPath,
		oldText: `        // \`allow-scripts\` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')`,
		newText: `        // Weave omits iframe sandbox: EPUB markup is sanitized before load.`,
	},
];

function patchMobileSelectionGuard() {
	if (!fs.existsSync(paginatorPath)) {
		return false;
	}

	let source = fs.readFileSync(paginatorPath, "utf8");
	if (source.includes(MOBILE_SELECTION_GUARD_MARKER)) {
		return false;
	}

	const OLD_POINTER_SELECTION = `        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {`;

	const NEW_POINTER_SELECTION = `        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            // ${MOBILE_SELECTION_GUARD_MARKER}: keep the paginated viewport still while
            // the user adjusts a text selection with native selection handles.
            const isMobileCoarsePointer =
                doc.defaultView?.matchMedia?.('(pointer: coarse)')?.matches === true &&
                doc.defaultView?.matchMedia?.('(any-pointer: fine)')?.matches !== true
            let hasTouchInput = false
            doc.addEventListener('touchstart', () => { hasTouchInput = true }, { once: true, passive: true })
            let isPointerSelecting = false
            let isTouchPointerSelecting = false
            doc.addEventListener('pointerdown', e => {
                isPointerSelecting = true
                isTouchPointerSelecting = e.pointerType === 'touch'
                if (e.pointerType === 'touch') hasTouchInput = true
            })
            doc.addEventListener('pointerup', () => {
                isPointerSelecting = false
                isTouchPointerSelecting = false
            })
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && !isTouchPointerSelecting && !isMobileCoarsePointer && !hasTouchInput && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {`;

	const OLD_FOCUSIN = `            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: \`requestAnimationFrame\` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))`;

	const NEW_FOCUSIN = `            doc.addEventListener('focusin', e => {
                // ${MOBILE_SELECTION_GUARD_MARKER}: focus changes during selection
                // handle drags must never re-anchor/scroll the paginated viewport.
                if (this.scrolled || isMobileCoarsePointer || hasTouchInput) return
                const selection = doc.getSelection()
                if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return
                // NOTE: \`requestAnimationFrame\` is needed in WebKit
                requestAnimationFrame(() => {
                    const currentSelection = doc.getSelection()
                    if (currentSelection && currentSelection.rangeCount > 0 && !currentSelection.isCollapsed) return
                    this.#scrollToAnchor(e.target)
                })
            })`;

	if (!source.includes(OLD_POINTER_SELECTION)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js pointer-selection contents; mobile selection guard patch not applied"
		);
		process.exit(1);
	}
	if (!source.includes(OLD_FOCUSIN)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js focusin contents; mobile selection guard patch not applied"
		);
		process.exit(1);
	}

	source = source
		.replace(OLD_POINTER_SELECTION, NEW_POINTER_SELECTION)
		.replace(OLD_FOCUSIN, NEW_FOCUSIN);
	fs.writeFileSync(paginatorPath, source, "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/paginator.js ${MOBILE_SELECTION_GUARD_MARKER}`
	);
	return true;
}

function patchSelectionTouchEndGuard() {
	if (!fs.existsSync(paginatorPath)) {
		return false;
	}

	const source = fs.readFileSync(paginatorPath, "utf8");
	if (source.includes(TOUCH_END_SELECTION_GUARD_MARKER)) {
		return false;
	}

	const OLD_TOUCH_END = `    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?`;

	const NEW_TOUCH_END = `    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return
        const doc = this.#view?.document
        const selection = doc?.getSelection()
        // ${TOUCH_END_SELECTION_GUARD_MARKER}: never snap/relocate while the user
        // is adjusting a native text selection.
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return

        // XXX: Firefox seems to report scale as 1... sometimes...?`;

	if (!source.includes(OLD_TOUCH_END)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js touchend contents; selection guard patch not applied"
		);
		process.exit(1);
	}

	fs.writeFileSync(paginatorPath, source.replace(OLD_TOUCH_END, NEW_TOUCH_END), "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/paginator.js ${TOUCH_END_SELECTION_GUARD_MARKER}`
	);
	return true;
}

function patchExpandSelectionGuard() {
	if (!fs.existsSync(paginatorPath)) {
		return false;
	}

	const source = fs.readFileSync(paginatorPath, "utf8");
	if (source.includes(EXPAND_SELECTION_GUARD_MARKER)) {
		return false;
	}

	const OLD_EXPAND = `            onExpand: () => this.#scrollToAnchor(this.#anchor),`;

	const NEW_EXPAND = `            onExpand: () => {
                const selection = this.#view?.document?.getSelection?.()
                // ${EXPAND_SELECTION_GUARD_MARKER}: do not re-anchor while a native
                // text selection is being adjusted.
                if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return
                this.#scrollToAnchor(this.#anchor)
            },`;

	const OLD_EXPAND_METHOD = `    expand() {
        const doc = this.document
        if (!doc?.documentElement) return
        const { documentElement } = doc`;

	const NEW_EXPAND_METHOD = `    expand() {
        const doc = this.document
        if (!doc?.documentElement) return
        const selection = doc.defaultView?.getSelection?.()
        // ${EXPAND_SELECTION_GUARD_MARKER}: never reflow columns while a native
        // text selection is being adjusted.
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return
        const { documentElement } = doc`;

	if (!source.includes(OLD_EXPAND)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js onExpand contents; selection guard patch not applied"
		);
		process.exit(1);
	}
	if (!source.includes(OLD_EXPAND_METHOD)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js View.expand contents; selection guard patch not applied"
		);
		process.exit(1);
	}

	source = source.replace(OLD_EXPAND, NEW_EXPAND).replace(OLD_EXPAND_METHOD, NEW_EXPAND_METHOD);
	fs.writeFileSync(paginatorPath, source, "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/paginator.js ${EXPAND_SELECTION_GUARD_MARKER}`
	);
	return true;
}

function patchPaginatorSelectionScrollFreeze() {
	if (!fs.existsSync(paginatorPath)) {
		return false;
	}

	let source = fs.readFileSync(paginatorPath, "utf8");
	if (source.includes(SELECTION_SCROLL_FREEZE_MARKER)) {
		return false;
	}

	const OLD_FIELD = `    #justAnchored = false`;
	const NEW_FIELD = `    #justAnchored = false
    // ${SELECTION_SCROLL_FREEZE_MARKER}: scroll position to freeze while the user
    // adjusts a native text selection (Android WebView scrolls #container's
    // scrollLeft for selection-handle visibility, moving the whole page).
    #selectionScrollAnchor = null`;

	const OLD_LOAD_TAIL = `            doc.addEventListener('focusin', e => {
                // weave-epub-reader mobile selection guard: focus changes during selection
                // handle drags must never re-anchor/scroll the paginated viewport.
                if (this.scrolled || isMobileCoarsePointer || hasTouchInput) return
                const selection = doc.getSelection()
                if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return
                // NOTE: \`requestAnimationFrame\` is needed in WebKit
                requestAnimationFrame(() => {
                    const currentSelection = doc.getSelection()
                    if (currentSelection && currentSelection.rangeCount > 0 && !currentSelection.isCollapsed) return
                    this.#scrollToAnchor(e.target)
                })
            })
        })`;

	const NEW_LOAD_TAIL = `            doc.addEventListener('focusin', e => {
                // weave-epub-reader mobile selection guard: focus changes during selection
                // handle drags must never re-anchor/scroll the paginated viewport.
                if (this.scrolled || isMobileCoarsePointer || hasTouchInput) return
                const selection = doc.getSelection()
                if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return
                // NOTE: \`requestAnimationFrame\` is needed in WebKit
                requestAnimationFrame(() => {
                    const currentSelection = doc.getSelection()
                    if (currentSelection && currentSelection.rangeCount > 0 && !currentSelection.isCollapsed) return
                    this.#scrollToAnchor(e.target)
                })
            })
            // ${SELECTION_SCROLL_FREEZE_MARKER}: while a non-collapsed selection is
            // being adjusted, any #container scroll that is not authored by foliate
            // (Android WebView scrolls it natively to keep the selection handles in
            // view) is reverted to the position at drag start. Paginated pages ride
            // on #container's scrollLeft, so without this the page visibly jumps.
            const updateSelectionScrollAnchor = () => {
                if (this.scrolled) { this.#selectionScrollAnchor = null; return }
                const activeSelection = doc.getSelection()
                if (activeSelection && activeSelection.rangeCount > 0 && !activeSelection.isCollapsed) {
                    if (this.#selectionScrollAnchor == null)
                        this.#selectionScrollAnchor = this.#container[this.scrollProp]
                } else {
                    this.#selectionScrollAnchor = null
                }
            }
            doc.addEventListener('selectionchange', updateSelectionScrollAnchor, { passive: true })
            if (!this.hasAttribute('data-weave-freeze-selection-scroll')) {
                this.setAttribute('data-weave-freeze-selection-scroll', '')
                this.#container.addEventListener('scroll', () => {
                    if (this.scrolled || this.#selectionScrollAnchor == null) return
                    const pos = this.#container[this.scrollProp]
                    if (pos !== this.#selectionScrollAnchor)
                        this.#container[this.scrollProp] = this.#selectionScrollAnchor
                })
            }
        })`;

	if (!source.includes(OLD_FIELD)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js field contents; selection scroll freeze patch not applied"
		);
		process.exit(1);
	}
	if (!source.includes(OLD_LOAD_TAIL)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/paginator.js load handler contents; selection scroll freeze patch not applied"
		);
		process.exit(1);
	}

	source = source.replace(OLD_FIELD, NEW_FIELD).replace(OLD_LOAD_TAIL, NEW_LOAD_TAIL);
	fs.writeFileSync(paginatorPath, source, "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/paginator.js ${SELECTION_SCROLL_FREEZE_MARKER}`
	);
	return true;
}

function patchViewRelocateReason() {
	if (!fs.existsSync(viewPath)) {
		console.warn(`[patch-foliate-paginator] Skipped: ${viewPath} not found`);
		return false;
	}

	let source = fs.readFileSync(viewPath, "utf8");
	if (source.includes(VIEW_RELOCATE_REASON_MARKER)) {
		return false;
	}

	const OLD = `        const cfi = this.getCFI(index, range)
        this.lastLocation = { ...progress, tocItem, pageItem, cfi, range }`;
	const NEW = `        const cfi = this.getCFI(index, range)
        // ${VIEW_RELOCATE_REASON_MARKER}: keep \`reason\` on the forwarded relocate so
        // host diagnostics can tell anchor/snap/page/navigation/scroll apart.
        this.lastLocation = { ...progress, tocItem, pageItem, cfi, range, reason }`;

	if (!source.includes(OLD)) {
		console.error(
			"[patch-foliate-paginator] Unexpected foliate-js/view.js relocate contents; relocate reason passthrough patch not applied"
		);
		process.exit(1);
	}

	fs.writeFileSync(viewPath, source.replace(OLD, NEW), "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/view.js ${VIEW_RELOCATE_REASON_MARKER}`
	);
	return true;
}

function patchFile(filePath, oldText, newText, label) {
	if (!fs.existsSync(filePath)) {
		console.warn(`[patch-foliate-paginator] Skipped missing file: ${filePath}`);
		return false;
	}

	let source = fs.readFileSync(filePath, "utf8");
	if (source.includes(newText)) {
		return false;
	}
	if (!source.includes(oldText)) {
		console.error(`[patch-foliate-paginator] Unexpected ${label} contents; patch not applied`);
		process.exit(1);
	}

	fs.writeFileSync(filePath, source.replace(oldText, newText), "utf8");
	console.log(`[patch-foliate-paginator] Patched ${label}`);
	return true;
}

const MAP_GROUPBY_POLYFILL = `if (typeof Map.groupBy !== "function") {
\tMap.groupBy = (items, keySelector) => {
\t\tconst result = new Map();
\t\tfor (const item of items) {
\t\t\tconst key = keySelector(item);
\t\t\tconst bucket = result.get(key) ?? [];
\t\t\tbucket.push(item);
\t\t\tresult.set(key, bucket);
\t\t}
\t\treturn result;
\t};
}`;

const OBJECT_GROUPBY_POLYFILL = `if (typeof Object.groupBy !== "function") {
\tObject.groupBy = (items, keySelector) => {
\t\tconst result = {};
\t\tfor (const item of items) {
\t\t\tconst key = keySelector(item);
\t\t\t(result[key] ??= []).push(item);
\t\t}
\t\treturn result;
\t};
}`;

function patchScrolledRenderGuards() {
	if (!fs.existsSync(paginatorPath)) {
		return false;
	}

	let source = fs.readFileSync(paginatorPath, "utf8");
	if (source.includes(SCROLLED_RENDER_GUARD_MARKER)) {
		return false;
	}

	let changed = false;
	for (const patch of SCROLLED_RENDER_GUARD_PATCHES) {
		if (!source.includes(patch.oldText)) {
			console.error(
				"[patch-foliate-paginator] Unexpected foliate-js/paginator.js contents; scrolled render guard patch not applied"
			);
			process.exit(1);
		}
		source = source.replace(patch.oldText, patch.newText);
		changed = true;
	}

	if (!changed) {
		return false;
	}

	fs.writeFileSync(paginatorPath, source, "utf8");
	console.log(
		`[patch-foliate-paginator] Patched foliate-js/paginator.js ${SCROLLED_RENDER_GUARD_MARKER}`
	);
	return true;
}

function patchEpubGroupByPolyfill() {
	if (!fs.existsSync(epubPath)) {
		console.warn(`[patch-foliate-paginator] Skipped: ${epubPath} not found`);
		return false;
	}

	let source = fs.readFileSync(epubPath, "utf8");
	let changed = false;

	if (!source.includes(GROUPBY_POLYFILL_MARKER)) {
		const prefix = `// ${GROUPBY_POLYFILL_MARKER}
${OBJECT_GROUPBY_POLYFILL}
${MAP_GROUPBY_POLYFILL}

`;
		source = prefix + source;
		changed = true;
	} else if (!source.includes("typeof Map.groupBy")) {
		source = source.replace(
			/(if \(typeof Object\.groupBy[\s\S]*?\n\})\n/,
			`$1\n${MAP_GROUPBY_POLYFILL}\n`
		);
		changed = true;
	}

	if (!changed) {
		return false;
	}

	fs.writeFileSync(epubPath, source, "utf8");
	console.log("[patch-foliate-paginator] Patched foliate-js/epub.js groupBy polyfills");
	return true;
}

if (!fs.existsSync(paginatorPath)) {
	console.warn(`[patch-foliate-paginator] Skipped: ${paginatorPath} not found`);
	process.exit(0);
}

let changed = false;

if (patchEpubGroupByPolyfill()) {
	changed = true;
}

if (patchScrolledRenderGuards()) {
	changed = true;
}

if (patchMobileSelectionGuard()) {
	changed = true;
}

if (patchSelectionTouchEndGuard()) {
	changed = true;
}

if (patchExpandSelectionGuard()) {
	changed = true;
}

if (patchPaginatorSelectionScrollFreeze()) {
	changed = true;
}

if (patchViewRelocateReason()) {
	changed = true;
}

if (!fs.readFileSync(paginatorPath, "utf8").includes("isLiveSelectionTarget")) {
	if (!fs.readFileSync(paginatorPath, "utf8").includes(OLD_SET_SELECTION)) {
		console.error("[patch-foliate-paginator] Unexpected foliate-js/paginator.js contents; patch not applied");
		process.exit(1);
	}
	let source = fs.readFileSync(paginatorPath, "utf8");
	source = source.replace(OLD_SET_SELECTION, NEW_SET_SELECTION).replace(OLD_RELOCATE, NEW_RELOCATE);
	fs.writeFileSync(paginatorPath, source, "utf8");
	console.log("[patch-foliate-paginator] Patched foliate-js/paginator.js selection guards");
	changed = true;
}

for (const patch of SANDBOX_PATCHES) {
	if (patchFile(patch.file, patch.oldText, patch.newText, path.basename(patch.file))) {
		changed = true;
	}
}

if (!changed) {
	console.log("[patch-foliate-paginator] Already patched");
}
