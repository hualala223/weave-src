/**
 * Minimal card shapes shared with the main Weave plugin bridge.
 * Kept intentionally small for the standalone EPUB reader.
 */

export interface Card {
	uuid: string;
	content: string;
	deckId?: string;
	sourceFile?: string;
	customFields?: Record<string, unknown>;
	persistenceSourcePath?: string;
	[key: string]: unknown;
}
