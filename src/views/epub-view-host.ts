import type { App } from "obsidian";
import type { EpubHostCapabilities } from "../services/epub";

export type EpubViewHost = {
	app: App;
} & EpubHostCapabilities;