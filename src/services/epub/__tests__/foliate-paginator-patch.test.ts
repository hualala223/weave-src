import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const paginatorPath = path.resolve(process.cwd(), "node_modules/foliate-js/paginator.js");
const viewPath = path.resolve(process.cwd(), "node_modules/foliate-js/view.js");

describe("foliate paginator runtime patch", () => {
	it("guards scrolled re-render when iframe document is not ready", () => {
		expect(fs.existsSync(paginatorPath)).toBe(true);
		const source = fs.readFileSync(paginatorPath, "utf8");
		expect(source).toContain("weave-epub-reader scrolled render guards");
		expect(source).toContain("if (!el?.style) return");
		expect(source).toContain("if (!doc?.documentElement || !doc.body) return");
		expect(source).toContain("if (width <= 0 || height <= 0) return");
	});

	it("keeps mobile selection-handle drags from auto-paging or re-anchoring", () => {
		expect(fs.existsSync(paginatorPath)).toBe(true);
		const source = fs.readFileSync(paginatorPath, "utf8");
		expect(source).toContain("weave-epub-reader mobile selection guard");
		expect(source).toContain("isMobileCoarsePointer");
		expect(source).toContain("isTouchPointerSelecting");
		expect(source).toContain("hasTouchInput");
		expect(source).toContain("!isTouchPointerSelecting && !isMobileCoarsePointer && !hasTouchInput");
		expect(source).toContain("focus changes during selection");
		expect(source).toContain("weave-epub-reader touchend selection guard");
		expect(source).toContain("never snap/relocate while the user");
		expect(source).toContain("weave-epub-reader expand selection guard");
		expect(source).toContain("do not re-anchor while a native");
	});

	it("freezes paginator container scroll while an Android selection handle is adjusted", () => {
		expect(fs.existsSync(paginatorPath)).toBe(true);
		const source = fs.readFileSync(paginatorPath, "utf8");
		expect(source).toContain("weave-epub-reader selection scroll freeze");
		expect(source).toContain("data-weave-freeze-selection-scroll");
		expect(source).toContain("#selectionScrollAnchor");
		// 冻结逻辑：非折叠选区激活时，任何非 foliate 发起的 #container 滚动都会弹回拖拽起点。
		expect(source).toContain("this.#container[this.scrollProp] = this.#selectionScrollAnchor");
	});

	it("forwards the foliate relocate reason through foliate-view for host diagnostics", () => {
		expect(fs.existsSync(viewPath)).toBe(true);
		const source = fs.readFileSync(viewPath, "utf8");
		expect(source).toContain("weave-epub-reader relocate reason passthrough");
		expect(source).toContain("cfi, range, reason");
	});
});
