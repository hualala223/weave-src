import { describe, expect, it, vi } from "vitest";

import {
	getCompatibleDataStorage,
	getCompatibleWeaveParentFolder,
	getCompatibleReadingMaterialManager,
	getCompatibleWeaveParentFolderFromSettingsOwner,
	getStandalonePlugin,
} from "../../../utils/plugin-access";
import { CURRENT_PLUGIN_ID } from "../../../config/plugin-runtime";

describe("plugin-access compatibility fallbacks", () => {
	it("resolves the current manifest plugin id before the fixed standalone id (fork scenario)", () => {
		const forkPlugin = {
			settings: {
				weaveParentFolder: "CONFIG/STORAGE",
			},
		};
		const app = {
			plugins: {
				getPlugin: (pluginId: string) => {
					if (pluginId === CURRENT_PLUGIN_ID) {
						return forkPlugin;
					}
					return null;
				},
			},
		} as any;

		expect(getStandalonePlugin(app)).toBe(forkPlugin);
		expect(getCompatibleWeaveParentFolder(app)).toBe("CONFIG/STORAGE");
	});

	it("still falls back to the fixed standalone plugin id when the manifest id differs", () => {
		const standalonePlugin = {
			settings: {
				weaveParentFolder: "StandaloneRoot",
			},
		};
		const app = {
			plugins: {
				getPlugin: (pluginId: string) => {
					if (pluginId === "weave-epub-reader") {
						return standalonePlugin;
					}
					return null;
				},
			},
		} as any;

		expect(getStandalonePlugin(app)).toBe(standalonePlugin);
	});

	it("falls back to Weave readingMaterialManager when standalone plugin exists but lacks the capability", () => {
		const legacyManager = {
			getAllMaterials: vi.fn(async () => []),
		};
		const app = {
			plugins: {
				getPlugin: (pluginId: string) => {
					if (pluginId === "weave-epub-reader") {
						return {};
					}
					if (pluginId === "weave") {
						return { readingMaterialManager: legacyManager };
					}
					return null;
				},
			},
		} as any;

		expect(getCompatibleReadingMaterialManager(app)).toBe(legacyManager);
	});

	it("falls back to Weave dataStorage when standalone plugin exists but lacks the capability", () => {
		const legacyDataStorage = {
			getAllCards: vi.fn(async () => []),
		};
		const app = {
			plugins: {
				getPlugin: (pluginId: string) => {
					if (pluginId === "weave-epub-reader") {
						return {};
					}
					if (pluginId === "weave") {
						return { dataStorage: legacyDataStorage };
					}
					return null;
				},
			},
		} as any;

		expect(getCompatibleDataStorage(app)).toBe(legacyDataStorage);
	});

	it("prefers the current plugin settings owner weaveParentFolder before app-level fallback", () => {
		const owner = {
			settings: {
				weaveParentFolder: "CurrentPluginRoot",
			},
			app: {
				plugins: {
					getPlugin: (pluginId: string) => {
						if (pluginId === "weave-epub-reader") {
							return {
								settings: {
									weaveParentFolder: "StandaloneRoot",
								},
							};
						}
						return null;
					},
				},
			},
		} as any;

	expect(getCompatibleWeaveParentFolderFromSettingsOwner(owner)).toBe("CurrentPluginRoot");
	});
});
