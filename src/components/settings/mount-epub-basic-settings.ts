import { Setting } from "obsidian";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
} from "../../config/reading-position-auto-save";
import { getEpubBacklinkHighlightService } from "../../services/epub/epub-backlink-highlight-access";
import { scheduleEpubAnnotationIndexWarmup } from "../../services/epub/epub-annotation-index";
import { showNotification } from "../../utils/notifications";
import type { InterfaceLanguagePreference } from "../../utils/i18n";
import { mountFolderSearchSetting } from "./epub-settings-folder-search";
import type {
	EpubBasicSettingsMountOptions,
	SettingsCleanupFn,
} from "./epub-settings-types";

const INTERFACE_LANGUAGE_OPTIONS: Array<{
	value: InterfaceLanguagePreference;
	labelKey: string;
}> = [
	{ value: "auto", labelKey: "epub.settings.basic.interfaceLanguageAuto" },
	{ value: "zh-CN", labelKey: "epub.settings.basic.interfaceLanguageZhCN" },
	{ value: "zh-TW", labelKey: "epub.settings.basic.interfaceLanguageZhTW" },
	{ value: "en-US", labelKey: "epub.settings.basic.interfaceLanguageEnUS" },
	{ value: "ja-JP", labelKey: "epub.settings.basic.interfaceLanguageJaJP" },
	{ value: "ko-KR", labelKey: "epub.settings.basic.interfaceLanguageKoKR" },
	{ value: "ru-RU", labelKey: "epub.settings.basic.interfaceLanguageRuRU" },
];

function clearHosts(hosts: EpubBasicSettingsMountOptions["hosts"]): void {
	hosts.interface.replaceChildren();
	hosts.reading.replaceChildren();
	hosts.diagnostics.replaceChildren();
}

export function mountEpubBasicSettings(options: EpubBasicSettingsMountOptions): SettingsCleanupFn {
	const { plugin, t, hosts, snapshot, callbacks } = options;
	const cleanupFns: SettingsCleanupFn[] = [];

	callbacks.setAutoSavePagesTextControl(null);
	clearHosts(hosts);

	new Setting(hosts.interface)
		.setName(t("epub.settings.basic.interfaceLanguage"))
		.setDesc(t("epub.settings.basic.interfaceLanguageDesc"))
		.setClass("epub-interface-language-setting")
		.addDropdown((dropdown) => {
			for (const option of INTERFACE_LANGUAGE_OPTIONS) {
				dropdown.addOption(option.value, t(option.labelKey));
			}
			dropdown.setValue(snapshot.interfaceLanguageValue);
			dropdown.onChange(async (value) => {
				await callbacks.updateInterfaceLanguage(value as InterfaceLanguagePreference);
			});
		});

	const weaveParentFolderSetting = new Setting(hosts.reading)
		.setName(t("epub.settings.basic.weaveParentFolder"))
		.setDesc(t("epub.settings.basic.weaveParentFolderDesc"))
		.setClass("epub-weave-parent-folder-setting");

	mountFolderSearchSetting({
		setting: weaveParentFolderSetting,
		placeholder: t("epub.settings.basic.weaveParentFolderPlaceholder"),
		value: snapshot.weaveParentFolderValue,
		onInput: callbacks.setWeaveParentFolderInput,
		onCommit: callbacks.updateWeaveParentFolder,
		onEscape: () => snapshot.weaveParentFolderValue,
		app: plugin.app,
		cleanupFns,
	});

	const bookmarkFolderSetting = new Setting(hosts.reading)
		.setName(t("epub.settings.basic.bookmarkFolder"))
		.setDesc(t("epub.settings.basic.bookmarkFolderDesc"))
		.setClass("epub-bookmark-setting");

	mountFolderSearchSetting({
		setting: bookmarkFolderSetting,
		placeholder: t("epub.settings.basic.bookmarkFolderPlaceholder"),
		value: snapshot.bookmarkFolderValue,
		onInput: callbacks.setBookmarkFolderInput,
		onCommit: callbacks.updateBookmarkFolder,
		onEscape: () => snapshot.bookmarkFolderValue,
		app: plugin.app,
		cleanupFns,
	});

	const highlightStoragePathSetting = new Setting(hosts.reading)
		.setName(t("epub.settings.basic.highlightStoragePath"))
		.setDesc(t("epub.settings.basic.highlightStoragePathDesc"))
		.setClass("epub-highlight-storage-path-setting");

	highlightStoragePathSetting.addText((text) => {
		text.setPlaceholder(t("epub.settings.basic.highlightStoragePathPlaceholder"));
		text.setValue(snapshot.highlightStoragePathInput);
		text.onChange((value) => {
			callbacks.setHighlightStoragePathInput(value);
		});

		const inputEl = text.inputEl;

		const commitValue = () => {
			void callbacks.updateHighlightStoragePath(inputEl.value);
		};

		const handleBlur = () => {
			commitValue();
		};

		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitValue();
				return;
			}

			if (event.key === "Escape") {
				callbacks.setHighlightStoragePathInput(snapshot.highlightStoragePathValue);
				text.setValue(snapshot.highlightStoragePathValue);
				inputEl.blur();
			}
		};

		inputEl.addEventListener("blur", handleBlur);
		inputEl.addEventListener("keydown", handleKeydown);

		cleanupFns.push(() => inputEl.removeEventListener("blur", handleBlur));
		cleanupFns.push(() => inputEl.removeEventListener("keydown", handleKeydown));
	});

	const autoSaveSetting = new Setting(hosts.reading)
		.setName(t("epub.settings.basic.autoSaveReadingPosition"))
		.setDesc(t("epub.settings.basic.autoSaveReadingPositionDesc"))
		.setClass("epub-reading-position-auto-save-toggle-setting");

	autoSaveSetting.addToggle((toggle) => {
		toggle.setValue(snapshot.continuousReadingPositionAutoSaveEnabled);
		toggle.onChange(async (value) => {
			await callbacks.updateContinuousReadingPositionAutoSaveEnabled(value);
		});
	});

	const autoSavePagesSetting = new Setting(hosts.reading)
		.setName(t("epub.settings.basic.autoSavePages"))
		.setDesc(
			t("epub.settings.basic.autoSavePagesDesc", {
				min: MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
				max: MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
				default: DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
			})
		)
		.setClass("epub-reading-position-auto-save-pages-setting");

	autoSavePagesSetting.addText((text) => {
		callbacks.setAutoSavePagesTextControl(text);
		text.inputEl.type = "number";
		text.inputEl.min = String(MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES);
		text.inputEl.max = String(MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES);
		text.setPlaceholder(String(DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES));
		text.setValue(snapshot.continuousReadingPositionAutoSavePagesInput);
		text.setDisabled(!snapshot.continuousReadingPositionAutoSaveEnabled);
		text.onChange((value) => {
			callbacks.setContinuousReadingPositionAutoSavePagesInput(value);
		});

		const inputEl = text.inputEl;

		const commitValue = () => {
			if (!snapshot.continuousReadingPositionAutoSaveEnabled) {
				callbacks.setContinuousReadingPositionAutoSavePagesInput(
					String(snapshot.continuousReadingPositionAutoSavePages)
				);
				text.setValue(String(snapshot.continuousReadingPositionAutoSavePages));
				return;
			}
			void callbacks.updateContinuousReadingPositionAutoSavePages(inputEl.value);
		};

		const handleBlur = () => {
			commitValue();
		};

		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitValue();
				return;
			}

			if (event.key === "Escape") {
				callbacks.setContinuousReadingPositionAutoSavePagesInput(
					String(snapshot.continuousReadingPositionAutoSavePages)
				);
				text.setValue(String(snapshot.continuousReadingPositionAutoSavePages));
				inputEl.blur();
			}
		};

		inputEl.addEventListener("blur", handleBlur);
		inputEl.addEventListener("keydown", handleKeydown);

		cleanupFns.push(() => inputEl.removeEventListener("blur", handleBlur));
		cleanupFns.push(() => inputEl.removeEventListener("keydown", handleKeydown));
	});

	new Setting(hosts.reading)
		.setName(t("epub.settings.basic.largeNavButtons"))
		.setDesc(t("epub.settings.basic.largeNavButtonsDesc"))
		.setClass("epub-large-nav-buttons-toggle-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.largeNavButtonsEnabled);
			toggle.onChange(async (value) => {
				await callbacks.updateLargeNavButtons(value);
			});
		});

	new Setting(hosts.diagnostics)
		.setName(t("epub.settings.basic.sourceNavigationOpenInNewTab"))
		.setDesc(t("epub.settings.basic.sourceNavigationOpenInNewTabDesc"))
		.setClass("epub-source-navigation-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.sourceNavigationOpenInNewTab);
			toggle.onChange(async (value) => {
				await callbacks.updateSourceNavigationOpenInNewTab(value);
			});
		});

	new Setting(hosts.diagnostics)
		.setName(t("epub.settings.basic.rebuildHighlightIndex"))
		.setDesc(t("epub.settings.basic.rebuildHighlightIndexDesc"))
		.setClass("epub-rebuild-highlight-index-setting")
		.addButton((button) => {
			button.setButtonText(t("epub.settings.basic.rebuildHighlightIndexAction"));
			button.onClick(async () => {
				button.setDisabled(true);
				try {
					const service = getEpubBacklinkHighlightService(plugin.app);
					await service.rebuildHighlightIndexes();
					scheduleEpubAnnotationIndexWarmup(plugin.app, 2_000, { forceAll: true });
					showNotification(t("epub.settings.basic.rebuildHighlightIndexSuccess"), "success");
				} catch (error) {
					console.error("[EpubSettings] rebuild highlight index failed:", error);
					showNotification(t("epub.settings.basic.rebuildHighlightIndexFailed"), "error");
				} finally {
					button.setDisabled(false);
				}
			});
		});

	new Setting(hosts.diagnostics)
		.setName(t("epub.settings.basic.debugMode"))
		.setDesc(t("epub.settings.basic.debugModeDesc"))
		.setClass("epub-debug-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.debugModeEnabled);
			toggle.onChange(async (value) => {
				await callbacks.updateDebugMode(value);
			});
		});

	return () => {
		cleanupFns.forEach((cleanup) => cleanup());
		callbacks.setAutoSavePagesTextControl(null);
		clearHosts(hosts);
	};
}
