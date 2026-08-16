import type { App } from "obsidian";

export type EpubViewHost = {
	app: App;
	openEpubReader?: (filePath: string) => Promise<void>;
};
