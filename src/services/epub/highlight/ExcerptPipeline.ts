import type { BacklinkHighlight } from "../EpubBacklinkHighlightService";
import { HighlightIndex } from "./HighlightIndex";

export interface HighlightReloadRequest {
	invalidateCache?: boolean;
	incremental?: boolean;
	delayMs?: number;
}

export interface ExcerptPipelineOptions {
	getEnableDebugMode?: () => boolean;
}

export class ExcerptPipeline {
	private readonly getEnableDebugMode?: () => boolean;

	constructor(
		readonly highlightIndex: HighlightIndex,
		options: ExcerptPipelineOptions = {}
	) {
		this.getEnableDebugMode = options.getEnableDebugMode;
	}

	syncCollectedHighlights(highlights: BacklinkHighlight[]): void {
		this.highlightIndex.buildFrom(highlights);
	}

	requestReload(request: HighlightReloadRequest, schedule: (request: HighlightReloadRequest) => void): void {
		schedule(request);
	}
}
