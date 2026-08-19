/**
 * 视图位置工具
 *
 * 判断视图位于内容区还是侧边栏，并据此解析表面背景变量。
 *
 * @module utils/view-location-utils
 */

import { WorkspaceLeaf } from "obsidian";

/** 视图位置类型 */
export type ViewLocation = "center" | "left" | "right";
export type ViewSurfaceContext = "main" | "sidebar";

export interface ViewSurfaceTokens {
	context: ViewSurfaceContext;
	surfaceBackground: string;
	elevatedBackground: string;
}

// 直接传递 Obsidian 官方 CSS 变量引用，而不是提前解析成固定颜色。
// 这样主题或容器对变量的覆盖仍能在具体 leaf 内继续生效，更接近官方视图的表现。
const MAIN_SURFACE_BACKGROUND = "var(--background-primary)";
const MAIN_ELEVATED_BACKGROUND = "var(--background-secondary)";
const SIDEBAR_SURFACE_BACKGROUND = "var(--background-secondary)";
const SIDEBAR_ELEVATED_BACKGROUND = "var(--background-primary)";

/**
 * 获取当前 leaf 的位置
 */
export function getLeafLocation(leaf: WorkspaceLeaf): ViewLocation {
	const workspace = leaf.view.app.workspace;
	const root = leaf.getRoot();

	// 主内容区优先用 rootSplit 判断，避免把主区标签页误判为侧边栏。
	if (root === workspace.rootSplit) {
		return "center";
	}

	// 检查是否在左侧边栏
	if (root === workspace.leftSplit) {
		return "left";
	}

	// 检查是否在右侧边栏
	if (root === workspace.rightSplit) {
		return "right";
	}

	// 某些布局下 root 不是直接的 left/rightSplit，这里用 DOM 结构兜底。
	const containerEl = ((leaf as unknown)?.containerEl ??
		(leaf.view as unknown)?.containerEl ??
		null) as HTMLElement | null;

	if (containerEl?.closest(".workspace-split.mod-left-split")) {
		return "left";
	}

	if (containerEl?.closest(".workspace-split.mod-right-split")) {
		return "right";
	}

	if (containerEl?.closest(".workspace-split.mod-root")) {
		return "center";
	}

	// 保守策略：只要不在 rootSplit，就按侧边栏处理，避免背景仍停留在主区颜色。
	return "right";
}

/**
 * 检查视图是否在侧边栏中
 */
export function isInSidebar(leaf: WorkspaceLeaf): boolean {
	const location = getLeafLocation(leaf);
	return location === "left" || location === "right";
}

/**
 * 获取视图所在容器的表面背景变量
 *
 * 侧边栏使用 Obsidian 侧栏背景，内容区使用主内容背景。
 */
export function getViewSurfaceTokens(leaf: WorkspaceLeaf): ViewSurfaceTokens {
	const inSidebar = isInSidebar(leaf);

	return {
		context: inSidebar ? "sidebar" : "main",
		surfaceBackground: inSidebar ? SIDEBAR_SURFACE_BACKGROUND : MAIN_SURFACE_BACKGROUND,
		elevatedBackground: inSidebar ? SIDEBAR_ELEVATED_BACKGROUND : MAIN_ELEVATED_BACKGROUND,
	};
}
