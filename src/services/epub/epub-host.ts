import type { App } from "obsidian";
import { CURRENT_PLUGIN_ID } from "../../config/plugin-runtime";
import { getLegacyWeavePlugin } from "../../utils/plugin-access";
import { getEpubRuntime } from "./epub-runtime";

export interface EpubHostSavedCardSnapshot {
	uuid?: string;
	content?: string;
	sourceFile?: string;
	sourceKind?: string;
	sourceSubunitKey?: string;
}

export interface EpubHostCreateCardInput {
	initialContent: string;
	onCardSaved?: (card: EpubHostSavedCardSnapshot) => void | Promise<void>;
}

export interface EpubHostReadingPointInput {
	filePath: string;
	selectedText: string;
	sourceLink?: string;
	successNotice?: string;
	initialTitle?: string;
}

export interface EpubHostScheduleChapterInput {
	filePath: string;
	title: string;
	tocHref: string;
	tocLevel: number;
	deckId?: string;
}

export interface EpubHostIncrementalReadingTopicOption {
	id: string;
	name: string;
}

export interface EpubHostResumePointInput {
	filePath: string;
	cfi: string;
	chapterHref?: string;
	chapterTitle?: string;
	deckId?: string;
}

export interface EpubHostCapabilities {
	getEpubStorageService?: () => import("./EpubStorageService").EpubStorageService;
	loadPublicationTocItems?: (
		filePath: string
	) => Promise<import("./types").TocItem[]>;
	navigateToPublicationChapter?: (
		filePath: string,
		tocHref: string,
		options?: { sourceId?: string; sourceMarkdownPath?: string }
	) => Promise<void>;
	buildPublicationChapterMarkdownLink?: (
		filePath: string,
		tocHref: string,
		chapterTitle?: string,
		sourceId?: string,
		chapterIndex?: number
	) => string;
	openEpubReader?: (filePath: string) => Promise<void>;
	openCreateCardModal?: (input: EpubHostCreateCardInput) => Promise<void>;
	openIRReadingPointFromExternalSelection?: (input: EpubHostReadingPointInput) => Promise<void>;
	getAvailableEpubIncrementalReadingTopics?: () => Promise<EpubHostIncrementalReadingTopicOption[]>;
	scheduleEpubChapterForIncrementalReading?: (input: EpubHostScheduleChapterInput) => Promise<void>;
	markEpubResumePointFromReader?: (input: EpubHostResumePointInput) => Promise<void>;
	openCardBacklinkFromEpub?: (cardUuid: string) => Promise<void>;
}

export type EpubWeaveExcerptRemovalMode = "auto" | "excerpt-only" | "delete-card";

export interface EpubWeaveOfficialAPIInfo {
	apiName?: string;
	apiVersion?: string;
	stage?: string;
	capabilities?: {
		excerpts?: {
			remove?: boolean;
			supportsSidLocator?: boolean;
			supportsExcerptId?: boolean;
			supportsInteractiveUserChoice?: boolean;
		};
	};
}

export interface EpubWeaveRemoveExcerptInput {
	sourceType: "epub";
	epubFilePath: string;
	cfiRange: string;
	cardId?: string;
	excerptId?: string;
	sourceFile?: string;
	sourceRef?: string;
	mode?: EpubWeaveExcerptRemovalMode;
}

export interface EpubWeaveRemoveExcerptResult {
	success: boolean;
	action: "excerpt-removed" | "card-deleted" | "noop";
	affectedCardIds: string[];
	sourceFile?: string;
	sourceRef?: string;
	needsUserChoice?: boolean;
	additionalContentPreview?: string;
	suggestedMode?: EpubWeaveExcerptRemovalMode;
	error?: string;
	warnings?: string[];
}

export interface EpubWeaveOfficialAPI {
	getInfo?: () => EpubWeaveOfficialAPIInfo;
	removeExcerpt?: (
		input: EpubWeaveRemoveExcerptInput
	) => Promise<EpubWeaveRemoveExcerptResult>;
}

const EPUB_HOST_CAPABILITY_KEYS: Array<keyof EpubHostCapabilities> = [
	"openEpubReader",
	"openCreateCardModal",
	"openIRReadingPointFromExternalSelection",
	"getAvailableEpubIncrementalReadingTopics",
	"scheduleEpubChapterForIncrementalReading",
	"markEpubResumePointFromReader",
	"openCardBacklinkFromEpub",
];

const registeredEpubHosts = new WeakMap<App, EpubHostCapabilities>();

type PluginHostApp = App & {
	plugins: {
		getPlugin(id: string): unknown;
	};
};

function getRuntimePluginHost(app: App): EpubHostCapabilities | null {
	const runtime = getEpubRuntime();
	const pluginLookup = app as PluginHostApp | { plugins?: unknown };
	if (!pluginLookup.plugins || typeof pluginLookup.plugins !== "object") {
		return null;
	}
	// 当前 manifest id（fork 场景）优先，其次固定 runtime id
	const pluginUnknown: unknown =
		(pluginLookup as PluginHostApp).plugins.getPlugin(CURRENT_PLUGIN_ID) ??
		(pluginLookup as PluginHostApp).plugins.getPlugin(runtime.pluginId);
	if (!pluginUnknown || typeof pluginUnknown !== "object") {
		return null;
	}

	return pluginUnknown as EpubHostCapabilities;
}

function getLegacyHost(app: App): EpubHostCapabilities | null {
	const legacyPlugin = getLegacyWeavePlugin(app);
	if (!legacyPlugin) {
		return null;
	}

	return Object.create(legacyPlugin) as EpubHostCapabilities;
}

function listEpubHostCandidates(app: App): EpubHostCapabilities[] {
	const candidates = [
		registeredEpubHosts.get(app) ?? null,
		getRuntimePluginHost(app),
		getLegacyHost(app),
	].filter((host): host is EpubHostCapabilities => Boolean(host));

	const uniqueHosts: EpubHostCapabilities[] = [];
	for (const host of candidates) {
		if (uniqueHosts.includes(host)) {
			continue;
		}
		uniqueHosts.push(host);
	}

	return uniqueHosts;
}

function composeEpubHost(app: App): EpubHostCapabilities | null {
	const hosts = listEpubHostCandidates(app);
	if (hosts.length === 0) {
		return null;
	}

	if (hosts.length === 1) {
		return hosts[0];
	}

	const primaryHost = hosts[0];
	const mergedHost = Object.create(primaryHost) as EpubHostCapabilities;

	for (const key of EPUB_HOST_CAPABILITY_KEYS) {
		for (const host of hosts) {
			const capability = host[key];
			if (capability === undefined) {
				continue;
			}

			const resolvedCapability =
				typeof capability === "function"
					? capability.bind(host)
					: capability;
			(mergedHost as Record<string, unknown>)[key] = resolvedCapability;
			break;
		}
	}

	return mergedHost;
}

export function registerEpubHost(app: App, host: EpubHostCapabilities): void {
	registeredEpubHosts.set(app, host);
}

export function unregisterEpubHost(app: App): void {
	registeredEpubHosts.delete(app);
}

export function resolveEpubHost(app: App): EpubHostCapabilities | null {
	return composeEpubHost(app);
}

export function resolveEpubWeaveOfficialAPI(app: App): EpubWeaveOfficialAPI | null {
	const hosts = listEpubHostCandidates(app) as Array<
		EpubHostCapabilities & {
			getOfficialAPI?: () => EpubWeaveOfficialAPI;
			weaveDomainService?: EpubWeaveOfficialAPI;
		}
	>;
	for (const host of hosts) {
		if (typeof host.getOfficialAPI === "function") {
			const api = host.getOfficialAPI();
			if (api) {
				return api;
			}
		}
		if (host.weaveDomainService) {
			return host.weaveDomainService;
		}
	}

	return null;
}