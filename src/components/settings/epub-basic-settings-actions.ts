import type { TextComponent } from "obsidian";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED,
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	normalizeContinuousReadingPositionAutoSaveEnabled,
	normalizeContinuousReadingPositionAutoSavePages,
} from "../../config/reading-position-auto-save";
import { normalizeEpubBookmarkFolderPath } from "../../services/epub";
import { normalizeHighlightStoragePath, normalizeWeaveParentFolder } from "../../config/paths";
import { syncLargeNavButtonStyle } from "../../services/epub/epub-large-nav-style";
import {
	normalizeInterfaceLanguagePreference,
	setInterfaceLanguagePreference,
	type InterfaceLanguagePreference,
} from "../../utils/i18n";
import { showNotification } from "../../utils/notifications";
import type StandaloneEpubPlugin from "../../main";
import type { EpubSettingsTranslateFn } from "./epub-settings-types";

export interface EpubBasicSettingsActionDeps {
	plugin: StandaloneEpubPlugin;
	getTranslate: () => EpubSettingsTranslateFn;
	getWeaveParentFolderValue: () => string;
	setWeaveParentFolderInput: (value: string) => void;
	getBookmarkFolderValue: () => string;
	getHighlightStoragePathValue: () => string;
	getInterfaceLanguageValue: () => InterfaceLanguagePreference;
	getPremiumPreviewEnabled: () => boolean;
	getContinuousReadingPositionAutoSaveEnabled: () => boolean;
	getContinuousReadingPositionAutoSavePages: () => number;
	getSourceNavigationOpenInNewTab: () => boolean;
	getLargeNavButtonsEnabled: () => boolean;
	getDebugModeEnabled: () => boolean;
	getAutoSavePagesTextControl: () => TextComponent | null;
	setBookmarkFolderInput: (value: string) => void;
	setHighlightStoragePathInput: (value: string) => void;
	setContinuousReadingPositionAutoSavePagesInput: (value: string) => void;
	setExcerptSettingsVersion: (updater: (value: number) => number) => void;
	save: () => Promise<void>;
}

export function createEpubBasicSettingsActions(deps: EpubBasicSettingsActionDeps) {
	const { plugin } = deps;
	const t = (key: string, params?: Record<string, string | number>) =>
		deps.getTranslate()(key, params);

	return {
		async updateWeaveParentFolder(folderPath: string): Promise<void> {
			const normalizedFolderPath = normalizeWeaveParentFolder(folderPath);
			if (normalizedFolderPath === deps.getWeaveParentFolderValue()) {
				deps.setWeaveParentFolderInput(normalizedFolderPath);
				return;
			}

			plugin.settings.weaveParentFolder = normalizedFolderPath;
			await deps.save();
			showNotification(t("epub.settings.notifications.weaveParentFolderUpdated"), "success");
		},

		async updateBookmarkFolder(folderPath: string): Promise<void> {
			const normalizedFolderPath = normalizeEpubBookmarkFolderPath(folderPath);
			if (!normalizedFolderPath) {
				deps.setBookmarkFolderInput(deps.getBookmarkFolderValue());
				return;
			}
			if (normalizedFolderPath === deps.getBookmarkFolderValue()) {
				deps.setBookmarkFolderInput(deps.getBookmarkFolderValue());
				return;
			}

			plugin.settings.bookmarkFolder = normalizedFolderPath;
			await deps.save();
			showNotification(t("epub.settings.notifications.bookmarkFolderUpdated"), "success");
		},

		async updateHighlightStoragePath(filePath: string): Promise<void> {
			const normalizedPath = normalizeHighlightStoragePath(filePath);
			deps.setHighlightStoragePathInput(normalizedPath);
			if (normalizedPath === deps.getHighlightStoragePathValue()) {
				return;
			}

			plugin.settings.highlightStoragePath = normalizedPath;
			await deps.save();
			showNotification(t("epub.settings.notifications.highlightStoragePathUpdated"), "success");
		},

		async updateInterfaceLanguage(value: InterfaceLanguagePreference): Promise<void> {
			const normalizedValue = normalizeInterfaceLanguagePreference(value);
			if (deps.getInterfaceLanguageValue() === normalizedValue) {
				return;
			}

			plugin.settings.interfaceLanguage = normalizedValue;
			setInterfaceLanguagePreference(normalizedValue);
			await deps.save();
			showNotification(t("epub.settings.notifications.interfaceLanguageUpdated"), "success");
		},

		async updatePremiumPreview(enabled: boolean): Promise<void> {
			if (deps.getPremiumPreviewEnabled() === enabled) {
				return;
			}

			plugin.settings.showPremiumFeaturesPreview = enabled;
			await deps.save();
			showNotification(
				enabled
					? t("epub.settings.notifications.premiumPreviewEnabled")
					: t("epub.settings.notifications.premiumPreviewDisabled"),
				"success"
			);
		},

		async updateContinuousReadingPositionAutoSaveEnabled(enabled: boolean): Promise<void> {
			const normalizedEnabled = normalizeContinuousReadingPositionAutoSaveEnabled(enabled);
			if (deps.getContinuousReadingPositionAutoSaveEnabled() === normalizedEnabled) {
				return;
			}

			plugin.settings.continuousReadingPositionAutoSaveEnabled = normalizedEnabled;
			if (plugin.settings.continuousReadingPositionAutoSavePages == null) {
				plugin.settings.continuousReadingPositionAutoSavePages =
					DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES;
			}
			await deps.save();

			const autoSavePagesTextControl = deps.getAutoSavePagesTextControl();
			autoSavePagesTextControl?.setDisabled(!normalizedEnabled);
			if (!normalizedEnabled) {
				const pages = normalizeContinuousReadingPositionAutoSavePages(
					plugin.settings.continuousReadingPositionAutoSavePages
				);
				autoSavePagesTextControl?.setValue(String(pages));
			}

			showNotification(
				normalizedEnabled
					? t("epub.settings.notifications.autoSaveEnabled")
					: t("epub.settings.notifications.autoSaveDisabled"),
				"success"
			);
		},

		async updateContinuousReadingPositionAutoSavePages(value: string): Promise<void> {
			const normalizedPages = normalizeContinuousReadingPositionAutoSavePages(value);
			deps.setContinuousReadingPositionAutoSavePagesInput(String(normalizedPages));

			if (deps.getContinuousReadingPositionAutoSavePages() === normalizedPages) {
				return;
			}

			plugin.settings.continuousReadingPositionAutoSavePages = normalizedPages;
			if (plugin.settings.continuousReadingPositionAutoSaveEnabled == null) {
				plugin.settings.continuousReadingPositionAutoSaveEnabled =
					DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED;
			}
			await deps.save();
			showNotification(
				t("epub.settings.notifications.autoSavePagesUpdated", { pages: normalizedPages }),
				"success"
			);
		},

		async updateSourceNavigationOpenInNewTab(enabled: boolean): Promise<void> {
			if (deps.getSourceNavigationOpenInNewTab() === enabled) {
				return;
			}

			plugin.settings.sourceNavigationOpenInNewTab = enabled;
			await deps.save();
		},

		async updateLargeNavButtons(enabled: boolean): Promise<void> {
			if (deps.getLargeNavButtonsEnabled() === enabled) {
				return;
			}

			plugin.settings.enableLargeNavButtons = enabled;
			syncLargeNavButtonStyle(enabled);
			await deps.save();
		},

		async updateDebugMode(enabled: boolean): Promise<void> {
			if (deps.getDebugModeEnabled() === enabled) {
				return;
			}

			plugin.settings.enableDebugMode = enabled;
			await deps.save();
			showNotification(
				enabled
					? t("epub.settings.notifications.debugEnabled")
					: t("epub.settings.notifications.debugDisabled"),
				"success"
			);
		},
	};
}
