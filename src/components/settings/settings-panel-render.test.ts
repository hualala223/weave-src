import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import EpubSettingsPanel from "./EpubSettingsPanel.svelte";
import { App, Plugin } from "obsidian";

type CreateOptions = {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
	placeholder?: string;
};

function patchObsidianDomPrototypes(): void {
	if (!(HTMLElement.prototype as any).createDiv) {
		(HTMLElement.prototype as any).createDiv = function (options?: CreateOptions) {
			const el = document.createElement("div");
			if (options?.cls) el.className = options.cls;
			if (typeof options?.text === "string") el.textContent = options.text;
			if (options?.placeholder) el.setAttribute("placeholder", options.placeholder);
			for (const [key, value] of Object.entries(options?.attr || {})) {
				el.setAttribute(key, value);
			}
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

	if (!(HTMLElement.prototype as any).createEl) {
		(HTMLElement.prototype as any).createEl = function (tag: string, options?: CreateOptions) {
			const el = document.createElement(tag);
			if (options?.cls) el.className = options.cls;
			if (typeof options?.text === "string") el.textContent = options.text;
			this.appendChild(el);
			return el;
		};
	}
}

function createPlugin(): Plugin {
	const app = new App();
	const plugin = new Plugin(app as any, { id: "fork-weave-epub-reader" });
	plugin.settings = {
		bookmarkFolder: "CONFIG/STORAGE/weave/epub-bookmarks",
		highlightStoragePath: "CONFIG/STORAGE/weave/local-storage.json",
		weaveParentFolder: "CONFIG/STORAGE",
		interfaceLanguage: "zh-CN",
		enableDebugMode: false,
		enableLargeNavButtons: false,
		showPremiumFeaturesPreview: false,
		sourceNavigationOpenInNewTab: true,
		continuousReadingPositionAutoSaveEnabled: true,
		continuousReadingPositionAutoSavePages: 1,
		selectionTranslation: {
			disabledBuiltinIds: [],
			customProviders: [],
			smartRoutingEnabled: false,
			preferNativeDictionaryApp: false,
			clipboardFallbackOnSchemeOpen: true,
		},
	};
	(plugin as any).app = app;
	(plugin as any).saveSettings = vi.fn(async () => undefined);
	(app as any).plugins = {
		getPlugin: vi.fn((id: string) => (id === "fork-weave-epub-reader" ? plugin : null)),
	};
	(app as any).vault.adapter = {
		exists: vi.fn(async () => false),
		read: vi.fn(async () => ""),
		write: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		remove: vi.fn(async () => undefined),
		getAllLoadedFiles: vi.fn(() => []),
	};
	return plugin;
}

describe("settings panel renders with fork plugin id", () => {
	beforeEach(() => {
		vi.resetModules();
		patchObsidianDomPrototypes();
	});

	it("renders the settings panel shell and group headers", async () => {
		const plugin = createPlugin();
		const { container } = render(EpubSettingsPanel, { props: { plugin } });

		await waitFor(
			() => {
				expect(container.querySelector(".epub-settings-root")).toBeTruthy();
			},
			{ timeout: 5000 }
		);
		expect(container.querySelector(".epub-settings-tabs")).toBeTruthy();
	});
});
