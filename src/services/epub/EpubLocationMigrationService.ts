import type { App } from "obsidian";
import { logger } from "../../utils/logger";
import type { EpubStorageService } from "./EpubStorageService";
import { flushEpubStoragePendingProgress } from "./EpubStorageService";
import type { EpubReaderEngine } from "./reader-engine-types";

export interface EpubLocationMigrationSummary {
	progressMigrated: boolean;
}

const EMPTY_SUMMARY: EpubLocationMigrationSummary = {
	progressMigrated: false,
};

export class EpubLocationMigrationService {
	private readonly app: App;
	private readonly storageService: EpubStorageService;
	private readonly readerService: EpubReaderEngine;

	constructor(app: App, storageService: EpubStorageService, readerService: EpubReaderEngine) {
		this.app = app;
		this.storageService = storageService;
		this.readerService = readerService;
	}

	async migrateBookData(bookId: string, filePath: string): Promise<EpubLocationMigrationSummary> {
		if (typeof this.readerService.canonicalizeLocation !== "function") {
			return { ...EMPTY_SUMMARY };
		}

		const summary: EpubLocationMigrationSummary = {
			...EMPTY_SUMMARY,
			progressMigrated: await this.migrateReadingProgress(bookId),
		};

		if (summary.progressMigrated) {
			logger.info("[EpubLocationMigrationService] Migrated legacy EPUB locations:", {
				bookId,
				filePath,
				...summary,
			});
		}

		return summary;
	}

	private async migrateReadingProgress(bookId: string): Promise<boolean> {
		const progress = await this.storageService.loadProgress(bookId);
		if (!progress?.cfi) {
			return false;
		}

		const nextCfi = await this.canonicalizeLocation(progress.cfi);
		if (!nextCfi || nextCfi === progress.cfi) {
			return false;
		}

		await this.storageService.saveProgress(bookId, {
			...progress,
			cfi: nextCfi,
		});
		await flushEpubStoragePendingProgress(this.storageService);
		return true;
	}

	private async canonicalizeLocation(cfi: string, textHint?: string): Promise<string | null> {
		if (!cfi || typeof this.readerService.canonicalizeLocation !== "function") {
			return null;
		}

		try {
			return await this.readerService.canonicalizeLocation(cfi, textHint);
		} catch (error) {
			logger.warn("[EpubLocationMigrationService] Failed to canonicalize location:", {
				cfi,
				error,
			});
			return null;
		}
	}
}
