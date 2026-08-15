import { describe, expect, it } from "vitest";
import {
	EPUB_CORE_FEATURE_ID_SET,
	EPUB_FEATURE_IDS,
	EPUB_PREMIUM_FEATURE_ID_SET,
	isEpubCoreFeature,
	isEpubPremiumFeature,
} from "../../../config/epub-feature-tier";

describe("epub-feature-tier", () => {
	it("treats excerpt notes and reading progress as core", () => {
		expect(isEpubCoreFeature(EPUB_FEATURE_IDS.EXCERPT_NOTES)).toBe(true);
		expect(isEpubCoreFeature(EPUB_FEATURE_IDS.READING_PROGRESS)).toBe(true);
		expect(isEpubCoreFeature(EPUB_FEATURE_IDS.READING_REFERENCE)).toBe(false);
	});

	it("lists premium epub capabilities separately from core", () => {
		expect(isEpubPremiumFeature(EPUB_FEATURE_IDS.READING_PROGRESS)).toBe(false);
		expect(isEpubPremiumFeature(EPUB_FEATURE_IDS.READING_REFERENCE)).toBe(true);
		expect(isEpubPremiumFeature(EPUB_FEATURE_IDS.PARAGRAPH_MODE)).toBe(true);
		expect(EPUB_CORE_FEATURE_ID_SET.size).toBeGreaterThan(0);
		expect(EPUB_PREMIUM_FEATURE_ID_SET.size).toBeGreaterThan(0);
	});
});
