/**
 * 全局大翻页按钮样式（合并自 Quickadd 注入脚本「weave-epub-reader 全局翻页按钮样式」）。
 *
 * 由插件设置 `enableLargeNavButtons` 控制，默认关闭。
 * 开启后：
 * - 上一页按钮放大为屏幕左侧 10% 宽，下一页为右侧 90% 宽，高度 10vh；
 * - 按钮隐藏但可点击（透明点按区）；
 * - 底部状态栏隐藏，阅读区底部留白清零；
 * - 关闭 foliate-paginator 的翻页滑动动画（移除 `animated` 属性，翻页立即切换）。
 *
 * 数值为写死常量，不提供设置项。
 */

const STYLE_ID = "weave-large-nav-style";

let largeNavButtonsEnabled = false;

/**
 * 当前「全局翻页按钮样式」开关状态。
 * reader-renderer-layout 依据该状态决定是否写入 foliate-paginator 的 animated 属性。
 */
export function isLargeNavButtonsEnabled(): boolean {
	return largeNavButtonsEnabled;
}

const LARGE_NAV_STYLE_CSS = `
.clickable-icon.epub-nav-btn:not(.vertical) {
	height: 10vh !important;
	opacity: 0;
	border-radius: 0 !important;
	margin: 0 !important;
	padding: 0 !important;
	cursor: pointer !important;
}
.clickable-icon.epub-nav-btn:not(.vertical):first-child {
	width: 10% !important;
}
.clickable-icon.epub-nav-btn:not(.vertical):last-child {
	width: 90% !important;
}
/* 隐藏底部导航状态区（上一页/下一页按钮已移除） */
.epub-nav-status {
	display: none !important;
}
`;

/**
 * 依据开关状态注入 / 移除全局翻页按钮样式，并同步关闭 / 恢复翻页滑动动画。
 * 样式注入到 document.head，对所有已打开的阅读器即时生效。
 * 翻页动画的恢复依赖 reader-renderer-layout 在下一次布局应用时重新写入 animated 属性。
 */
export function syncLargeNavButtonStyle(enabled: boolean): void {
	largeNavButtonsEnabled = enabled;
	if (typeof document === "undefined") {
		return;
	}
	if (enabled) {
		document.querySelectorAll("foliate-paginator").forEach((el) => {
			el.removeAttribute("animated");
		});
	}
	const existing = document.getElementById(STYLE_ID);
	if (!enabled) {
		existing?.remove();
		return;
	}
	if (existing) {
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = LARGE_NAV_STYLE_CSS;
	document.head.appendChild(style);
}
