import type { TextComponent } from "obsidian";
import type StandaloneEpubPlugin from "../../main";

export type EpubSettingsTabId = "basic";

export type SettingsCleanupFn = () => void;

export interface EpubBasicSettingsHosts {
	interface: HTMLElement;
	reading: HTMLElement;
	diagnostics: HTMLElement;
}

export interface EpubBasicSettingsSnapshot {
	dataPathValue: string;
	dataPathInput: string;
	continuousReadingPositionAutoSaveEnabled: boolean;
	continuousReadingPositionAutoSavePages: number;
	continuousReadingPositionAutoSavePagesInput: string;
	sourceNavigationOpenInNewTab: boolean;
	excerptParagraphHoverPreviewEnabled: boolean;
	showAutoInsertButtonOnReader: boolean;
	largeNavButtonsEnabled: boolean;
	debugModeEnabled: boolean;
}

export interface EpubBasicSettingsCallbacks {
	save: () => Promise<void>;
	setDataPathInput: (value: string) => void;
	setContinuousReadingPositionAutoSavePagesInput: (value: string) => void;
	setAutoSavePagesTextControl: (control: TextComponent | null) => void;
	updateDataPath: (dataPath: string) => Promise<void>;
	updateContinuousReadingPositionAutoSaveEnabled: (enabled: boolean) => Promise<void>;
	updateContinuousReadingPositionAutoSavePages: (value: string) => Promise<void>;
	updateSourceNavigationOpenInNewTab: (enabled: boolean) => Promise<void>;
	updateExcerptParagraphHoverPreview: (enabled: boolean) => Promise<void>;
	updateShowAutoInsertButtonOnReader: (enabled: boolean) => Promise<void>;
	updateLargeNavButtons: (enabled: boolean) => Promise<void>;
	updateDebugMode: (enabled: boolean) => Promise<void>;
}

export interface EpubBasicSettingsMountOptions {
	plugin: StandaloneEpubPlugin;
	hosts: EpubBasicSettingsHosts;
	snapshot: EpubBasicSettingsSnapshot;
	callbacks: EpubBasicSettingsCallbacks;
}
