import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import { CURRENT_PLUGIN_ID } from "../../config/plugin-runtime";
import {
	DEFAULT_EPUB_BOOKMARK_FOLDER,
	isPathUnderEpubBookmarkFolder,
	normalizeEpubBookmarkFolderPath,
} from "./epub-bookmark-folder-path";
import { getEpubRuntime } from "./epub-runtime";
import { getCompatiblePlugin } from "../../utils/plugin-access";

export function resolveEpubBookmarkFolderForApp(app: App): string {
	const runtimePluginId = getEpubRuntime().pluginId;
	const pluginLookup = app as App & {
		plugins?: {
			getPlugin?: (id: string) => { settings?: { bookmarkFolder?: string } } | null;
		};
	};
	// 当前实际运行插件（manifest id，fork 场景下与 runtime id 不同）的设置优先；
	// 其次 runtime id（独立构建名），最后才是兼容宿主回退。
	const plugin =
		pluginLookup.plugins?.getPlugin?.(CURRENT_PLUGIN_ID) ??
		pluginLookup.plugins?.getPlugin?.(runtimePluginId) ??
		(getCompatiblePlugin(pluginLookup as unknown) as { settings?: { bookmarkFolder?: string } } | null);
	return (
		normalizeEpubBookmarkFolderPath(plugin?.settings?.bookmarkFolder) ||
		DEFAULT_EPUB_BOOKMARK_FOLDER
	);
}

/**
 * Paths maintained by the EPUB bookmark page (data notes, covers). Vault writes here
 * must not re-trigger reader highlight aggregation — otherwise syncAnalytics loops.
 */
export function isEpubBookmarkManagedVaultPath(app: App, path?: string | null): boolean {
	const normalizedPath = normalizePath(String(path || "").trim());
	if (!normalizedPath) {
		return false;
	}

	const bookmarkFolder = resolveEpubBookmarkFolderForApp(app);
	return isPathUnderEpubBookmarkFolder(normalizedPath, bookmarkFolder);
}
