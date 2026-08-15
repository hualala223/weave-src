import type { TextComponent } from "obsidian";
import type { InterfaceLanguagePreference } from "../../utils/i18n";
import type StandaloneEpubPlugin from "../../main";

export type EpubSettingsTabId = "basic";

export type SettingsCleanupFn = () => void;

export type EpubSettingsTranslateFn = (
	key: string,
	params?: Record<string, string | number>
) => string;

export interface EpubBasicSettingsHosts {
	interface: HTMLElement;
	reading: HTMLElement;
	diagnostics: HTMLElement;
}

export interface EpubBasicSettingsSnapshot {
	interfaceLanguageValue: InterfaceLanguagePreference;
	weaveParentFolderValue: string;
	weaveParentFolderInput: string;
	bookmarkFolderValue: string;
	bookmarkFolderInput: string;
	highlightStoragePathValue: string;
	highlightStoragePathInput: string;
	continuousReadingPositionAutoSaveEnabled: boolean;
	continuousReadingPositionAutoSavePages: number;
	continuousReadingPositionAutoSavePagesInput: string;
	sourceNavigationOpenInNewTab: boolean;
	largeNavButtonsEnabled: boolean;
	debugModeEnabled: boolean;
}

export interface EpubBasicSettingsCallbacks {
	save: () => Promise<void>;
	setWeaveParentFolderInput: (value: string) => void;
	setBookmarkFolderInput: (value: string) => void;
	setHighlightStoragePathInput: (value: string) => void;
	setContinuousReadingPositionAutoSavePagesInput: (value: string) => void;
	setAutoSavePagesTextControl: (control: TextComponent | null) => void;
	updateWeaveParentFolder: (folderPath: string) => Promise<void>;
	updateBookmarkFolder: (folderPath: string) => Promise<void>;
	updateHighlightStoragePath: (filePath: string) => Promise<void>;
	updateInterfaceLanguage: (value: InterfaceLanguagePreference) => Promise<void>;
	updateContinuousReadingPositionAutoSaveEnabled: (enabled: boolean) => Promise<void>;
	updateContinuousReadingPositionAutoSavePages: (value: string) => Promise<void>;
	updateSourceNavigationOpenInNewTab: (enabled: boolean) => Promise<void>;
	updateLargeNavButtons: (enabled: boolean) => Promise<void>;
	updateDebugMode: (enabled: boolean) => Promise<void>;
}

export interface EpubBasicSettingsMountOptions {
	plugin: StandaloneEpubPlugin;
	t: EpubSettingsTranslateFn;
	hosts: EpubBasicSettingsHosts;
	snapshot: EpubBasicSettingsSnapshot;
	callbacks: EpubBasicSettingsCallbacks;
}
