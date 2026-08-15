import { describe, expect, it, vi } from "vitest";
import { ExcerptPipeline } from "../highlight/ExcerptPipeline";
import { HighlightIndex } from "../highlight/HighlightIndex";
import type { BacklinkHighlight } from "../EpubBacklinkHighlightService";

describe("ExcerptPipeline", () => {
	it("builds the highlight index from collected highlights", () => {
		const index = new HighlightIndex();
		const pipeline = new ExcerptPipeline(index);
		const highlights: BacklinkHighlight[] = [
			{
				cfiRange: "epubcfi(/6/2)",
				color: "yellow",
				text: "Hello",
				sourceFile: "Books/demo.epub",
			},
		];

		pipeline.syncCollectedHighlights(highlights);

		expect(index.getSnapshot()).toHaveLength(1);
	});

	it("delegates reload requests to the scheduler", () => {
		const pipeline = new ExcerptPipeline(new HighlightIndex());
		const schedule = vi.fn();

		pipeline.requestReload({ incremental: true, delayMs: 300 }, schedule);

		expect(schedule).toHaveBeenCalledWith({ incremental: true, delayMs: 300 });
	});
});
