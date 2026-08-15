import type { TextComponent } from "obsidian";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_ENABLED,
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	normalizeContinuousReadingPositionAutoSaveEnabled,
	normalizeContinuousReadingPositionAutoSavePages,
} from "../../config/reading-position-auto-save";
import { normalizeDataPath } from "../../config/paths";
import { syncLargeNavButtonStyle } from "../../services/epub/epub-large-nav-style";
import { showNotification } from "../../utils/notifications";
import type StandaloneEpubPlugin from "../../main";

export interface EpubBasicSettingsActionDeps {
	plugin: StandaloneEpubPlugin;
	getDataPathValue: () => string;
	setDataPathInput: (value: string) => void;
	getContinuousReadingPositionAutoSaveEnabled: () => boolean;
	getContinuousReadingPositionAutoSavePages: () => number;
	getSourceNavigationOpenInNewTab: () => boolean;
	getLargeNavButtonsEnabled: () => boolean;
	getDebugModeEnabled: () => boolean;
	getAutoSavePagesTextControl: () => TextComponent | null;
	setContinuousReadingPositionAutoSavePagesInput: (value: string) => void;
	setExcerptSettingsVersion: (updater: (value: number) => number) => void;
	save: () => Promise<void>;
}

export function createEpubBasicSettingsActions(deps: EpubBasicSettingsActionDeps) {
	const { plugin } = deps;

	return {
		async updateDataPath(dataPath: string): Promise<void> {
			const normalizedPath = normalizeDataPath(dataPath);
			if (normalizedPath === deps.getDataPathValue()) {
				deps.setDataPathInput(normalizedPath);
				return;
			}

			plugin.settings.dataPath = normalizedPath;
			await deps.save();
			showNotification('数据路径已更新', "success");
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
					? '已开启自动记录阅读位置'
					: '已关闭自动记录阅读位置',
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
				`已将自动记录阈值更新为 ${normalizedPages} 页`,
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
					? '已开启调试模式'
					: '已关闭调试模式',
				"success"
			);
		},
	};
}
