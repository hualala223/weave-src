import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceLocateOverlayService } from "./SourceLocateOverlayService";

type CreateOptions = {
	cls?: string;
	text?: string;
};

vi.mock("obsidian", () => ({
	setIcon: vi.fn((element: HTMLElement, iconName: string) => {
		element.setAttribute("data-icon", iconName);
	}),
}));

describe("SourceLocateOverlayService", () => {
	beforeEach(() => {
		document.body.innerHTML = "";

		if (!(HTMLElement.prototype as any).createDiv) {
			(HTMLElement.prototype as any).createDiv = function (options?: CreateOptions) {
				const el = document.createElement("div");
				if (options?.cls) el.className = options.cls;
				if (typeof options?.text === "string") el.textContent = options.text;
				this.appendChild(el);
				return el;
			};
		}

		if (!(HTMLElement.prototype as any).createSpan) {
			(HTMLElement.prototype as any).createSpan = function (options?: CreateOptions) {
				const el = document.createElement("span");
				if (options?.cls) el.className = options.cls;
				if (typeof options?.text === "string") el.textContent = options.text;
				this.appendChild(el);
				return el;
			};
		}

		if (!(HTMLElement.prototype as any).setCssProps) {
			(HTMLElement.prototype as any).setCssProps = function (props: Record<string, string>) {
				for (const [key, value] of Object.entries(props || {})) {
					this.style.setProperty(key, value);
				}
			};
		}

		if (!(Range.prototype as any).getBoundingClientRect) {
			Object.defineProperty(Range.prototype, "getBoundingClientRect", {
				configurable: true,
				value: () => new DOMRect(0, 0, 0, 0),
			});
		}

		vi.restoreAllMocks();
	});

	it("uses viewport positioning even when the input rect only provides x and y", () => {
		const service = new SourceLocateOverlayService();

		service.showAtRect({ x: 320, y: 188, width: 196, height: 26 } as any, {
			label: "定位到溯源位置",
		});

		const overlay = document.body.querySelector(".weave-source-locate-overlay") as HTMLElement | null;
		expect(overlay).not.toBeNull();
		expect(overlay?.classList.contains("weave-source-locate-overlay")).toBe(true);
		expect(overlay?.style.left).toMatch(/px$/);
		expect(overlay?.style.top).toMatch(/px$/);
		expect(overlay?.style.left).not.toContain("NaN");
		expect(overlay?.style.top).not.toContain("NaN");
		expect(Number.parseFloat(overlay?.style.left || "0")).toBeGreaterThan(320);
		expect(Number.parseFloat(overlay?.style.top || "0")).toBeGreaterThan(188);
	});

	it("does not render the locate overlay when rect coordinates are invalid", () => {
		const service = new SourceLocateOverlayService();

		service.showAtRect({ width: 160, height: 24 } as any, {
			label: "定位到溯源位置",
		});

		expect(document.body.querySelector(".weave-source-locate-overlay")).toBeNull();
	});
});
