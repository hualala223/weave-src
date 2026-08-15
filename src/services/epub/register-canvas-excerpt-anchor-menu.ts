import { Notice, type App, type Plugin } from "obsidian";
import {
	getCanvasExcerptAnchorState,
	readCanvasExcerptAnchorStateFromCache,
	resolveActiveCanvasFilePath,
	setCanvasExcerptAnchorLock,
	warmCanvasExcerptAnchorCache,
} from "./canvas-excerpt-anchor";
import {
	CANVAS_NODE_MENU_EVENT,
	registerCanvasWorkspaceMenuEvent,
} from "./canvas-workspace-menu-bridge";

async function toggleCanvasExcerptAnchorLock(
	app: App,
	canvasPath: string,
	nodeId: string
): Promise<void> {
	const normalizedNodeId = String(nodeId || "").trim();
	if (!normalizedNodeId) {
		new Notice("请先选中一个 canvas 节点");
		return;
	}

	const current = await getCanvasExcerptAnchorState(app, canvasPath);
	const isLocked = String(current.lockedNodeId || "").trim() === normalizedNodeId;
	const nextLock = isLocked ? null : normalizedNodeId;
	await setCanvasExcerptAnchorLock(app, canvasPath, nextLock);
	new Notice(nextLock ? "已固定摘录锚点" : "已取消固定摘录锚点");
}

function registerCanvasNodePinMenu(app: App, plugin: Plugin): void {
	registerCanvasWorkspaceMenuEvent(plugin, CANVAS_NODE_MENU_EVENT, (menu, node) => {
		const canvasPath = resolveActiveCanvasFilePath(app);
		const nodeId = String(node?.id || "").trim();
		if (!canvasPath || !nodeId) {
			return;
		}

		const state = readCanvasExcerptAnchorStateFromCache(app, canvasPath);
		const isLocked = String(state.lockedNodeId || "").trim() === nodeId;
		menu.addItem((item) => {
			item
				.setTitle(
					isLocked
						? "取消固定阅读器摘录锚点"
						: "固定阅读器摘录锚点"
				)
				.setIcon("pin")
				.setChecked(isLocked)
				.onClick(() => {
					void toggleCanvasExcerptAnchorLock(app, canvasPath, nodeId);
				});
		});
		void warmCanvasExcerptAnchorCache(app, canvasPath);
	});
}

export function registerCanvasExcerptAnchorMenu(plugin: Plugin): void {
	registerCanvasNodePinMenu(plugin.app, plugin);
}
