import { describe, expect, it } from "vitest";
import { CURRENT_PLUGIN_ID } from "../../../config/plugin-runtime";
import {
	isEpubBookmarkManagedVaultPath,
	resolveEpubBookmarkFolderForApp,
} from "../epub-bookmark-vault-path";

describe("epub-bookmark-vault-path", () => {
	const app = {
		plugins: {
			getPlugin: () => ({
				settings: {
					bookmarkFolder: "Library/epub-data",
				},
			}),
		},
	} as any;

	it("resolves bookmark folder from plugin settings", () => {
		expect(resolveEpubBookmarkFolderForApp(app)).toBe("Library/epub-data");
	});

	it("treats bookmark data notes and cover assets as plugin-maintained paths", () => {
		expect(isEpubBookmarkManagedVaultPath(app, "Library/epub-data/data_Demo.md")).toBe(true);
		expect(isEpubBookmarkManagedVaultPath(app, "Library/epub-data/covers/demo.jpg")).toBe(
			true
		);
		expect(isEpubBookmarkManagedVaultPath(app, "Notes/demo.md")).toBe(false);
	});

	it("prefers the current manifest plugin id over the fixed standalone runtime id (fork scenario)", () => {
		const forkApp = {
			plugins: {
				getPlugin: (pluginId: string) => {
					if (pluginId === CURRENT_PLUGIN_ID) {
						return {
							settings: {
								bookmarkFolder: "CONFIG/STORAGE/weave/epub-bookmarks",
							},
						};
					}
					// runtime id（非 fork）与兼容宿主均不可用
					return null;
				},
			},
		} as any;

		expect(resolveEpubBookmarkFolderForApp(forkApp)).toBe(
			"CONFIG/STORAGE/weave/epub-bookmarks"
		);
	});

	it("falls back to the default folder when no plugin provides a bookmarkFolder", () => {
		const emptyApp = {
			plugins: {
				getPlugin: () => null,
			},
		} as any;

		expect(resolveEpubBookmarkFolderForApp(emptyApp)).toBe("weave/epub-bookmarks");
	});
});
