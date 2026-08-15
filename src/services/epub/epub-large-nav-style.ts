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

const BODY_CLASS = "weave-large-nav-enabled";

let largeNavButtonsEnabled = false;

/**
 * 当前「全局翻页按钮样式」开关状态。
 * reader-renderer-layout 依据该状态决定是否写入 foliate-paginator 的 animated 属性。
 */
export function isLargeNavButtonsEnabled(): boolean {
	return largeNavButtonsEnabled;
}

/**
 * 依据开关状态启用 / 停用全局翻页按钮样式，并同步关闭 / 恢复翻页滑动动画。
 * 静态 CSS 位于 src/styles/epub/epub-reader.css（body.weave-large-nav-enabled 前缀），
 * 运行时仅切换 body class（Obsidian 社区规范禁止动态创建 style 元素）。
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
	document.body.classList.toggle(BODY_CLASS, enabled);
}
