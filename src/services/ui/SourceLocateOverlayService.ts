import { setIcon } from "obsidian";

interface LocateOverlayOptions {
	label?: string;
	icon?: string;
	durationMs?: number;
}

const DEFAULT_DURATION = 2600;

interface RectLike {
	left?: number;
	top?: number;
	right?: number;
	bottom?: number;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

/**
 * 阅读器内的「已定位」浮层（书内跳转闪现）。
 * 溯源反链 UI 已移除，此服务仅保留 in-book 跳转时显示的定位提示浮层。
 */
export class SourceLocateOverlayService {
	private overlayEl: HTMLElement | null = null;
	private timer: number | null = null;

	showAtRect(
		rect: DOMRect | DOMRectReadOnly | RectLike | null | undefined,
		options: LocateOverlayOptions = {}
	): boolean {
		const normalizedRect = this.normalizeDisplayRect(rect);
		if (!normalizedRect) return false;
		this.clear();

		const label = options.label || "已定位";
		const icon = options.icon || "map-pinned";
		const overlay = activeDocument.body.createDiv({ cls: "weave-source-locate-overlay" });
		overlay.classList.add("weave-source-locate-overlay--measuring");
		overlay.setCssProps({
			top: "-9999px",
			left: "-9999px",
		});
		const iconWrap = overlay.createDiv({ cls: "weave-source-locate-overlay__icon" });
		setIcon(iconWrap, icon);
		overlay.createSpan({ cls: "weave-source-locate-overlay__label", text: label });

		const overlayWidth = Math.max(0, overlay.offsetWidth || 220);
		const overlayHeight = Math.max(0, overlay.offsetHeight || 40);
		const top = this.clamp(
			normalizedRect.top + Math.min(12, Math.max(4, normalizedRect.height * 0.18)),
			12,
			Math.max(12, window.innerHeight - overlayHeight - 12)
		);
		const left = this.clamp(
			normalizedRect.left + Math.min(18, Math.max(6, normalizedRect.width * 0.12)),
			12,
			Math.max(12, window.innerWidth - overlayWidth - 12)
		);

		overlay.classList.remove("weave-source-locate-overlay--measuring");
		overlay.setCssProps({
			top: `${top}px`,
			left: `${left}px`,
		});
		this.overlayEl = overlay;
		this.timer = window.setTimeout(() => this.clear(), options.durationMs ?? DEFAULT_DURATION);
		return true;
	}

	showTopCenter(anchor: HTMLElement, options: LocateOverlayOptions = {}): void {
		const rect = anchor.getBoundingClientRect();
		const virtualRect = new DOMRect(rect.left + rect.width / 2 - 70, rect.top + 24, 140, 24);
		this.showAtRect(virtualRect, options);
	}

	clear(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.overlayEl?.remove();
		this.overlayEl = null;
	}

	private normalizeDisplayRect(
		rect: DOMRect | DOMRectReadOnly | RectLike | null | undefined
	): DOMRect | null {
		if (!rect) {
			return null;
		}

		const left = this.pickFiniteNumber(rect.left, rect.x);
		const top = this.pickFiniteNumber(rect.top, rect.y);
		const width = this.pickFiniteNumber(rect.width);
		const height = this.pickFiniteNumber(rect.height);
		const right = this.pickFiniteNumber(rect.right);
		const bottom = this.pickFiniteNumber(rect.bottom);

		const resolvedWidth = width ?? (left !== null && right !== null ? right - left : null);
		const resolvedHeight = height ?? (top !== null && bottom !== null ? bottom - top : null);
		const resolvedLeft =
			left ?? (right !== null && resolvedWidth !== null ? right - resolvedWidth : null);
		const resolvedTop =
			top ?? (bottom !== null && resolvedHeight !== null ? bottom - resolvedHeight : null);

		if (
			resolvedLeft === null ||
			resolvedTop === null ||
			resolvedWidth === null ||
			resolvedHeight === null
		) {
			return null;
		}

		if (
			!Number.isFinite(resolvedLeft) ||
			!Number.isFinite(resolvedTop) ||
			!Number.isFinite(resolvedWidth) ||
			!Number.isFinite(resolvedHeight)
		) {
			return null;
		}

		if (resolvedWidth === 0 && resolvedHeight === 0) {
			return null;
		}

		return new DOMRect(
			resolvedLeft,
			resolvedTop,
			Math.max(0, resolvedWidth),
			Math.max(0, resolvedHeight)
		);
	}

	private pickFiniteNumber(...values: Array<number | string | undefined>): number | null {
		for (const value of values) {
			const numericValue =
				typeof value === "number"
					? value
					: typeof value === "string" && value.trim()
						? Number(value)
						: Number.NaN;
			if (Number.isFinite(numericValue)) {
				return numericValue;
			}
		}
		return null;
	}

	private clamp(value: number, min: number, max: number): number {
		if (!Number.isFinite(value)) {
			return min;
		}
		if (!Number.isFinite(min)) {
			min = 0;
		}
		if (!Number.isFinite(max)) {
			return Math.max(value, min);
		}
		if (max < min) {
			return min;
		}
		return Math.min(Math.max(value, min), max);
	}
}

let sourceLocateOverlayService: SourceLocateOverlayService | null = null;

export function getSourceLocateOverlayService(): SourceLocateOverlayService {
	if (!sourceLocateOverlayService) {
		sourceLocateOverlayService = new SourceLocateOverlayService();
	}
	return sourceLocateOverlayService;
}
