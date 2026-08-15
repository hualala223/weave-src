import type { EpubReaderEngine } from '../reader-engine-types';
import { EpubLocationMigrationService } from '../EpubLocationMigrationService';

function createStorageServiceMock() {
	return {
		loadProgress: vi.fn(),
		saveProgress: vi.fn(),
		flushPendingProgress: vi.fn(),
		ensureSourceIdentity: vi.fn(),
	} as any;
}

describe('EpubLocationMigrationService', () => {
	it('migrates legacy reading progress into readium locators and keeps the unified summary shape', async () => {
		const storageService = createStorageServiceMock();
		storageService.loadProgress.mockResolvedValue({
			chapterIndex: 1,
			cfi: '/6/4',
			percent: 42,
		});

		const canonicalizeLocation = vi.fn(async (cfi: string) => {
			if (cfi === '/6/4') {
				return 'readium:progress';
			}
			return null;
		});
		const readerService = {
			canonicalizeLocation,
		} as Partial<EpubReaderEngine> as EpubReaderEngine;

		const service = new EpubLocationMigrationService({} as any, storageService, readerService);
		const summary = await service.migrateBookData('book-1', 'Books/demo.epub');

		expect(summary).toEqual({
			progressMigrated: true,
		});
		expect(storageService.saveProgress).toHaveBeenCalledWith('book-1', {
			chapterIndex: 1,
			cfi: 'readium:progress',
			percent: 42,
		});
		expect(storageService.flushPendingProgress).toHaveBeenCalledTimes(1);
	});

	it('skips progress migration when the reader engine does not expose a canonicalize hook', async () => {
		const storageService = createStorageServiceMock();
		const readerService = {} as EpubReaderEngine;
		const service = new EpubLocationMigrationService({} as any, storageService, readerService);

		const summary = await service.migrateBookData('book-1', 'Books/demo.epub');

		expect(summary).toEqual({
			progressMigrated: false,
		});
		expect(storageService.loadProgress).not.toHaveBeenCalled();
	});
});
