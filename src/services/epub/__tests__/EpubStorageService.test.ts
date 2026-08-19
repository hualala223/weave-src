import { Platform, TFile } from 'obsidian';
import { EpubStorageService, flushEpubStoragePendingProgress } from '../EpubStorageService';
import type { EpubBook } from '../types';

const SYNC_EPUB_ROOT = 'weave/incremental-reading/epub-reading';
const LOCAL_EPUB_DATA_PATH = '.obsidian/plugins/weave/state/epub-local-state.json';
const LEGACY_LOCAL_EPUB_DATA_PATH = '.obsidian/plugins/weave/state/incremental-reading/epub-reader-data.json';
const LOCAL_EPUB_SCAN_INDEX_PATH = '.obsidian/plugins/weave/cache/epub-scan-index.json';
const LOCAL_EPUB_STATE_ROOT = '.obsidian/plugins/weave/state/incremental-reading/reader-state/epub';
const LOCAL_EPUB_PARAGRAPH_MODE_POSITIONS_PATH =
	'CONFIG/STORAGE/cache/epub-paragraph-mode-positions.json';
const LOCAL_EPUB_ARTIFACTS_ROOT = '.obsidian/plugins/weave/cache/incremental-reading/reader-artifacts/epub';

/** Bookmarks now persist in the unified weave-data.json store (default data path). */
const DATA_PATH = 'CONFIG/STORAGE';
const WEAVE_DATA_FILE = `${DATA_PATH}/weave-data.json`;

async function flushWeaveDataStore(app: any) {
  const { getSchemaV2Store } = await import('../schema-v2-store');
  await getSchemaV2Store(app, () => DATA_PATH).flush();
}

function readWeaveBookmarks(files: Map<string, string>): Record<string, unknown> {
  if (!files.has(WEAVE_DATA_FILE)) {
    return {};
  }
  const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
  return (parsed.bookmarks ?? {}) as Record<string, unknown>;
}

/** schema v2 `books` 分区（聚合形状）。 */
function toV2StoreBooks(books: Record<string, EpubBook>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(books).map(([id, book]) => [
      id,
      {
        id,
        file: {
          vaultPath: book.filePath,
          sourceId: book.sourceId,
          sourceFingerprint: book.sourceFingerprint,
        },
        meta: book.metadata,
        reading: {
          position: book.currentPosition,
          stats: book.readingStats,
        },
        notes: { bookmarks: [], highlights: [], excerpts: [] },
        audit: { createdAt: 1, updatedAt: 1 },
      },
    ])
  );
}

/** 读取 weave-data.json 中某本书的 v2 聚合。 */
function readV2Book(files: Map<string, string>, id: string): any {
  const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
  return parsed.books?.[id];
}

async function flushSchemaV2Store(app: any) {
  const { getSchemaV2Store } = await import('../schema-v2-store');
  await getSchemaV2Store(app, () => DATA_PATH).flush();
}

function resolveLocalEpubDataPath(files: Map<string, string>): string {
  return (
    Array.from(files.keys()).find((path) => path.endsWith('/epub-local-state.json')) ||
    LOCAL_EPUB_DATA_PATH
  );
}

/** 从 weave-data.json 组装旧的 epub-local-data 形状，便于既有断言复用。 */
function readLocalEpubData(files: Map<string, string>) {
  if (!files.has(WEAVE_DATA_FILE)) {
    return {
      version: 1,
      updatedAt: 0,
      bookCatalogStoredLocally: false,
    };
  }
  const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? 0,
    bookCatalogStoredLocally: parsed.books !== undefined,
    books: parsed.books,
    bookshelfMembership: parsed.bookshelfMembership,
    bookshelfPlaylists: parsed.bookshelfPlaylists,
    readerSettings: parsed.readerSettings,
    excerptSettings: parsed.excerptSettings,
    uiMemory: parsed.uiMemory,
  };
}

function readShelfScanIndex(files: Map<string, string>): Array<{ path: string }> {
  if (!files.has(WEAVE_DATA_FILE)) {
    return [];
  }
  const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
  return (parsed.shelf?.scanIndex ?? []) as Array<{ path: string }>;
}

function readTraceabilityRegistry(files: Map<string, string>): Array<Record<string, unknown>> {
  if (!files.has(WEAVE_DATA_FILE)) {
    return [];
  }
  const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
  return (parsed.traceability?.sourceRegistry ?? []) as Array<Record<string, unknown>>;
}

/** 将 EpubBook 目录转成 weave-data.json `books` 分区（本地记录形状）。 */
function toStoreBooksSection(books: Record<string, EpubBook>): Record<string, { descriptor: unknown }> {
  return Object.fromEntries(
    Object.entries(books).map(([id, book]) => [
      id,
      {
        descriptor: {
          id,
          filePath: book.filePath,
          sourceId: book.sourceId,
          sourceFingerprint: book.sourceFingerprint,
          sourceMtime: book.sourceMtime,
          sourceSize: book.sourceSize,
          metadata: book.metadata,
        },
      },
    ])
  );
}

function createMemoryApp(
  initialFiles: Record<string, string> = {},
  vaultFiles: string[] = [],
  binaryFiles: Record<string, string | Uint8Array> = {}
) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const writes: string[] = [];
  const normalizedVaultFiles = new Set(vaultFiles.map((path) => path.replace(/\\/g, '/')));
  const normalizedBinaryFiles = new Map(
    Object.entries(binaryFiles).map(([path, value]) => [path.replace(/\\/g, '/'), value] as const)
  );

  const ensureParentDirs = (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
    }
  };

  const list = (dir: string) => {
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = normalizedDir ? `${normalizedDir}/` : '';
    const folders = new Set<string>();
    const directFiles: string[] = [];
    const allPaths = new Set<string>([
      ...Array.from(files.keys()),
      ...Array.from(normalizedVaultFiles),
    ]);

    for (const path of allPaths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      if (!rest.includes('/')) {
        directFiles.push(path);
        continue;
      }
      const folder = rest.split('/')[0];
      folders.add(prefix ? `${prefix}${folder}` : folder);
    }

    return { files: directFiles, folders: Array.from(folders) };
  };

  const createVaultFile = (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    const extension = normalized.split('.').pop() || '';
    const basename = normalized.split('/').pop()?.replace(/\.[^.]+$/, '') || normalized;
    const folder = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    return Object.assign(Object.create(TFile.prototype), {
      path: normalized,
      extension,
      basename,
      name: normalized.split('/').pop() || normalized,
      stat: { size: 1024 },
      parent: folder ? { path: folder } : null,
    });
  };

  const adapter = {
    exists: vi.fn(async (path: string) => {
      const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
      if (files.has(normalized) || normalizedVaultFiles.has(normalized)) return true;
      const prefix = normalized ? `${normalized}/` : '';
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          return true;
        }
      }
      for (const vaultFilePath of normalizedVaultFiles) {
        if (vaultFilePath.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    }),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, content: string) => {
      ensureParentDirs(path);
      files.set(path, content);
      writes.push(path);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path.replace(/\\/g, '/'));
    }),
    mkdir: vi.fn(async () => {}),
    list: vi.fn(async (dir: string) => list(dir)),
    stat: vi.fn(async (path: string) => {
      const normalized = path.replace(/\\/g, '/');
      if (!normalizedVaultFiles.has(normalized)) {
        throw new Error(`Missing file: ${normalized}`);
      }
      return { size: 1024, mtime: 1710000000000 };
    }),
    readBinary: vi.fn(async (path: string) => {
      const normalized = path.replace(/\\/g, '/');
      const value = normalizedBinaryFiles.get(normalized) ?? normalized;
      return value instanceof Uint8Array ? value : new TextEncoder().encode(value);
    }),
    rmdir: vi.fn(async (dir: string) => {
      const prefix = `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
      for (const key of Array.from(files.keys())) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    }),
  };

  const app: any = {
    vault: {
      adapter,
      configDir: '.obsidian',
      getAbstractFileByPath: vi.fn((path: string) => {
        const normalized = path.replace(/\\/g, '/');
        if (files.has(normalized)) {
          return createVaultFile(normalized);
        }
        return normalizedVaultFiles.has(normalized) ? createVaultFile(normalized) : null;
      }),
      getFiles: vi.fn(() => {
        const paths = new Set<string>([
          ...Array.from(normalizedVaultFiles),
          ...Array.from(files.keys()).filter((path) => path.endsWith('.md')),
        ]);
        return Array.from(paths).map((path) => createVaultFile(path));
      }),
      read: vi.fn(async (file: TFile) => {
        const normalized = file.path.replace(/\\/g, '/');
        const value = files.get(normalized);
        if (value === undefined) {
          throw new Error(`Missing file: ${normalized}`);
        }
        return value;
      }),
      modify: vi.fn(async (file: TFile, content: string) => {
        const normalized = file.path.replace(/\\/g, '/');
        files.set(normalized, content);
        writes.push(normalized);
      }),
      create: vi.fn(async (path: string, content = '') => {
        const normalized = path.replace(/\\/g, '/');
        normalizedVaultFiles.add(normalized);
        if (content) {
          files.set(normalized, content);
        }
        writes.push(normalized);
        return createVaultFile(normalized);
      }),
    },
    fileManager: {
      trashFile: vi.fn(async (file: TFile) => {
        const normalized = file.path.replace(/\\/g, '/');
        normalizedVaultFiles.delete(normalized);
        normalizedBinaryFiles.delete(normalized);
        files.delete(normalized);
      }),
    },
    plugins: {
      getPlugin: vi.fn(() => ({
        settings: { weaveParentFolder: '', dataPath: DATA_PATH },
      })),
    },
  };

  return { app, files, writes, vaultFiles: normalizedVaultFiles };
}

function createBook(overrides: Partial<EpubBook> = {}): EpubBook {
  return {
    id: 'book-1',
    filePath: 'Books/demo.epub',
    metadata: {
      title: 'Demo',
      author: 'Author',
      chapterCount: 3,
      coverImage: 'data:image/jpeg;base64,AAAA',
    },
    currentPosition: {
      chapterIndex: 0,
      cfi: '/6/2',
      percent: 10,
    },
    readingStats: {
      totalReadTime: 0,
      lastReadTime: 100,
      createdTime: 50,
    },
    ...overrides,
  };
}

async function withPlatformIsMobile<T>(value: boolean, run: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Platform, 'isMobile');
  Object.defineProperty(Platform, 'isMobile', {
    configurable: true,
    value,
  });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Platform, 'isMobile', originalDescriptor);
    } else {
      (Platform as { isMobile?: boolean }).isMobile = undefined;
    }
  }
}

describe('EpubStorageService', () => {
  it('returns the updated comfortable reading defaults when no reader settings were saved', async () => {
    const { app } = createMemoryApp();

    const service = new EpubStorageService(app);
    const settings = await service.loadReaderSettings();

    expect(settings.lineHeight).toBe(1.72);
    expect(settings.viewportSidePadding).toBe(24);
    expect(settings.widthMode).toBe('standard');
    expect(settings.layoutMode).toBe('paginated');
    expect(settings.flowMode).toBe('paginated');
    expect(settings.footnoteClickAction).toBe('preview');
  });

  it('returns scrolled reader defaults on mobile when no reader settings were saved', async () => {
    const { app } = createMemoryApp();

    await withPlatformIsMobile(true, async () => {
      const service = new EpubStorageService(app);
      const settings = await service.loadReaderSettings();

      expect(settings.lineHeight).toBe(1.66);
      expect(settings.viewportSidePadding).toBe(18);
      expect(settings.widthMode).toBe('full');
      expect(settings.layoutMode).toBe('paginated');
      expect(settings.flowMode).toBe('scrolled');
    });
  });

  it('stores reader settings in the schema v2 top-level on mobile', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        readerSettings: {
          flowMode: 'paginated',
          layoutMode: 'paginated',
        },
      }),
    });

    await withPlatformIsMobile(true, async () => {
      const service = new EpubStorageService(app);
      await service.saveReaderSettings({
        lineHeight: 1.9,
        letterSpacing: 0.02,
        pageMargin: 40,
        viewportSidePadding: 22,
        widthMode: 'full',
        layoutMode: 'paginated',
        flowMode: 'scrolled',
        showScrolledSideNav: true,
        footnoteClickAction: 'navigate',
		showTopSticker: true,
        topStickerLayout: 'auto',
        paragraphModeEnabled: false,
        paragraphModeFontSize: 'medium',
        paragraphModeFontScale: 100,
        paragraphModeSurfaceStyle: 'spotlight',
        paragraphModeTransitionStyle: 'settle',
      });
    });

    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(files.has(LOCAL_EPUB_DATA_PATH)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/reader-settings.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/reader-settings.mobile.json`)).toBe(false);
    expect(parsed.readerSettings.flowMode).toBe('scrolled');
    expect(parsed.readerSettings.viewportSidePadding).toBe(22);
    // v2 已去掉 paragraphMode* 死字段
    expect(parsed.readerSettings.paragraphModeEnabled).toBeUndefined();
    expect(parsed.readerSettings.paragraphModeFontSize).toBeUndefined();
  });

  it('preserves stored mobile paginated settings', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        readerSettings: {
          lineHeight: 1.66,
          widthMode: 'full',
          layoutMode: 'paginated',
          flowMode: 'paginated',
          showScrolledSideNav: true,
          footnoteClickAction: 'preview',
          showTopSticker: true,
          topStickerLayout: 'auto',
        },
      }),
    });

    await withPlatformIsMobile(true, async () => {
      const service = new EpubStorageService(app);
      const settings = await service.loadReaderSettings();

      expect(settings.layoutMode).toBe('paginated');
      expect(settings.flowMode).toBe('paginated');
    });
  });

  it('preserves explicit mobile paginated settings', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        readerSettings: {
          lineHeight: 1.82,
          widthMode: 'full',
          layoutMode: 'paginated',
          flowMode: 'paginated',
          showScrolledSideNav: false,
          footnoteClickAction: 'navigate',
			showTopSticker: false,
          topStickerLayout: 'sidebar',
        },
      }),
    });

    await withPlatformIsMobile(true, async () => {
      const service = new EpubStorageService(app);
      const settings = await service.loadReaderSettings();

      expect(settings.lineHeight).toBe(1.82);
      expect(settings.layoutMode).toBe('paginated');
      expect(settings.flowMode).toBe('paginated');
      expect(settings.showScrolledSideNav).toBe(false);
      expect(settings.footnoteClickAction).toBe('navigate');
    });
  });

  it('keeps explicit stored desktop reader settings without legacy default upgrades', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        readerSettings: {
          lineHeight: 1.9,
          widthMode: 'full',
          layoutMode: 'paginated',
          flowMode: 'paginated',
          showScrolledSideNav: true,
          footnoteClickAction: 'preview',
			showTopSticker: true,
          topStickerLayout: 'auto',
        },
      }),
    });

    const service = new EpubStorageService(app);
    const settings = await service.loadReaderSettings();

    expect(settings.lineHeight).toBe(1.9);
    expect(settings.widthMode).toBe('full');
    expect(settings.layoutMode).toBe('paginated');
    expect(settings.flowMode).toBe('paginated');
  });

  it('migrates retired container width mode to fit in reader settings', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        readerSettings: {
          lineHeight: 1.78,
          letterSpacing: 0.01,
          pageMargin: 36,
          viewportSidePadding: 24,
          widthMode: 'container',
          layoutMode: 'paginated',
          flowMode: 'paginated',
          showScrolledSideNav: true,
          footnoteClickAction: 'preview',
			showTopSticker: true,
          topStickerLayout: 'inline',
        },
      }),
    });

    const service = new EpubStorageService(app);

    const settings = await service.loadReaderSettings();

    expect(settings.widthMode).toBe('fit');
    expect(settings.pageMargin).toBe(36);
    expect(settings.lineHeight).toBe(1.78);
    expect(settings.topStickerLayout).toBe('inline');
  });

  it('loads the bookshelf catalog from the unified weave-data store with persisted reading state', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({
          'book-1': createBook({
            currentPosition: { chapterIndex: 1, cfi: '/6/6', percent: 42 },
          }),
        }),
      }),
    });

    const service = new EpubStorageService(app);
    const books = await service.loadBooks({ hydrateStates: true });
    const book = Object.values(books)[0];

    expect(book?.currentPosition.percent).toBe(42);
    expect(files.has(`${SYNC_EPUB_ROOT}/books.json`)).toBe(false);
    expect(files.has(LOCAL_EPUB_DATA_PATH)).toBe(false);
  });

  it('stores reading progress in the schema v2 book aggregate without rewriting books.json', async () => {
    const booksPath = `${SYNC_EPUB_ROOT}/books.json`;
    const { app, files, writes } = createMemoryApp(
      {
        [booksPath]: JSON.stringify({
          'book-1': createBook(),
        }),
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({ 'book-1': createBook() }),
        }),
      },
      ['Books/demo.epub']
    );

    const service = new EpubStorageService(app);

    await service.saveProgress('book-1', {
      chapterIndex: 2,
      cfi: '/6/8',
      percent: 66,
    });
    await service.flushPendingProgress();

    expect(writes).not.toContain(booksPath);
    const progress = await service.loadProgress('book-1');

    expect(files.has(booksPath)).toBe(false);
    expect(progress?.percent).toBe(66);
    expect(writes).not.toContain(booksPath);

    await flushSchemaV2Store(app);
    expect(readV2Book(files, 'book-1').reading.position.percent).toBe(66);
    expect(readV2Book(files, 'book-1').reading.stats.lastReadTime).toBeGreaterThan(0);
    // No legacy per-book markdown page is created anymore.
    expect(
      Array.from(files.keys()).some((path) => path.includes('weave/epub-bookmarks/') && path.endsWith('.md'))
    ).toBe(false);
  });

  it('flushes debounced progress when flushPendingProgress is missing on a legacy instance', async () => {
    const { app, files } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({ 'book-1': createBook() }),
        }),
      },
      ['Books/demo.epub']
    );

    const service = new EpubStorageService(app);
    await service.saveProgress('book-1', {
      chapterIndex: 1,
      cfi: '/6/4',
      percent: 33,
    });

    const legacyService = service as EpubStorageService & {
      flushPendingProgress?: EpubStorageService['flushPendingProgress'];
    };
    delete legacyService.flushPendingProgress;

    await flushEpubStoragePendingProgress(service);

    const progress = await service.loadProgress('book-1');
    expect(progress?.percent).toBe(33);

    await flushSchemaV2Store(app);
    expect(readV2Book(files, 'book-1').reading.position.percent).toBe(33);
  });

  it('ignores flush when the storage service reference is missing', async () => {
    await expect(
      flushEpubStoragePendingProgress(undefined as unknown as EpubStorageService)
    ).resolves.toBeUndefined();
  });

  it('marks and clears book completion without rewriting locator percent', async () => {
    const { app } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({ 'book-1': createBook() }),
        }),
      },
      ['Books/demo.epub']
    );

    const service = new EpubStorageService(app);
    await service.saveProgress('book-1', {
      chapterIndex: 8,
      cfi: '/6/80',
      percent: 96,
    });
    await service.flushPendingProgress();

    const completed = await service.markBookCompleted('book-1', 12345);
    expect(completed?.readingStats.completedTime).toBe(12345);

    const afterComplete = await service.getBook('book-1');
    expect(afterComplete?.currentPosition.percent).toBe(96);
    expect(afterComplete?.readingStats.completedTime).toBe(12345);

    const cleared = await service.clearBookCompletion('book-1');
    expect(cleared?.readingStats.completedTime).toBeUndefined();
    expect(cleared?.currentPosition.percent).toBe(96);
  });

  it('hydrates persisted per-book state on reload from the schema v2 aggregate', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({
          'book-1': createBook({
            currentPosition: { chapterIndex: 1, cfi: '/6/6', percent: 42 },
            readingStats: { totalReadTime: 10, lastReadTime: 999, createdTime: 50 },
          }),
        }),
      }),
    });

    const service = new EpubStorageService(app);
    const book = await service.findBookByFilePath('Books/demo.epub');

    expect(book?.currentPosition.percent).toBe(42);
    expect(book?.readingStats.lastReadTime).toBe(999);
  });

  it('stores and loads the manual last-open bookmark in the schema v2 aggregate', async () => {
    const { app, files } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({ 'book-1': createBook() }),
        }),
      },
      ['Books/demo.epub']
    );
    const service = new EpubStorageService(app);

    await service.saveLastOpenBookmark('book-1', {
      chapterIndex: 2,
      cfi: '/6/10',
      percent: 61.5,
      title: '第三章',
      preview: '第三章',
      savedAt: 1710000000000,
    });

    await flushSchemaV2Store(app);
    const aggregate = readV2Book(files, 'book-1');
    expect(aggregate).toBeTruthy();
    expect(aggregate.reading.lastPosition?.cfi).toBe('/6/10');
    expect(aggregate.reading.lastPosition?.percent).toBe(61.5);
    expect(aggregate.reading.position.percent).toBe(61.5);
    // No legacy per-book markdown page is created anymore.
    expect(
      Array.from(files.keys()).some((path) => path.includes('weave/epub-bookmarks/') && path.endsWith('.md'))
    ).toBe(false);

    const restored = await service.loadLastOpenBookmark('book-1');
    expect(restored?.cfi).toBe('/6/10');
    expect(restored?.percent).toBe(61.5);
    expect(restored?.chapterIndex).toBe(2);
    expect(restored?.savedAt).toBe(1710000000000);
  });

  it('loads the last-open bookmark from the persisted schema v2 lastPosition', async () => {
    const { app } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: {
            'book-1': {
              id: 'book-1',
              file: { vaultPath: 'Books/demo.epub' },
              meta: createBook().metadata,
              reading: {
                position: { chapterIndex: 1, cfi: 'epubcfi(/6/8!/4/2/4)', percent: 33.3 },
                lastPosition: {
                  chapterIndex: 1,
                  cfi: 'epubcfi(/6/8!/4/2/4)',
                  percent: 33.3,
                  title: 'Demo',
                  preview: 'Demo',
                  savedAt: 1710000000001,
                },
                stats: { totalReadTime: 0, lastReadTime: 1710000000001, createdTime: 100 },
              },
              notes: { bookmarks: [], highlights: [], excerpts: [] },
              audit: { createdAt: 1, updatedAt: 1 },
            },
          },
        }),
      },
      ['Books/demo.epub']
    );
    const service = new EpubStorageService(app);

    await expect(service.loadLastOpenBookmark('book-1')).resolves.toEqual({
      chapterIndex: 1,
      cfi: 'epubcfi(/6/8!/4/2/4)',
      percent: 33.3,
      title: 'Demo',
      preview: 'Demo',
      savedAt: 1710000000001,
    });
  });

  it('stores, loads, and clears the reading reference point in the schema v2 lastPosition', async () => {
    const { app, files } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({ 'book-1': createBook() }),
        }),
      },
      ['Books/demo.epub']
    );
    const service = new EpubStorageService(app);

    await service.saveReadingReferencePoint('book-1', {
      chapterIndex: 3,
      cfi: 'epubcfi(/6/14!/4/2/8)',
      percent: 48.2,
      title: '第四章',
      savedAt: 1710000001000,
    });

    await flushSchemaV2Store(app);
    expect(readV2Book(files, 'book-1').reading.lastPosition).toEqual({
      chapterIndex: 3,
      cfi: 'epubcfi(/6/14!/4/2/8)',
      percent: 48.2,
      title: '第四章',
      preview: '第四章',
      savedAt: 1710000001000,
    });

    await expect(service.loadReadingReferencePoint('book-1')).resolves.toEqual({
      chapterIndex: 3,
      cfi: 'epubcfi(/6/14!/4/2/8)',
      percent: 48.2,
      title: '第四章',
      savedAt: 1710000001000,
    });

    await service.deleteReadingReferencePoint('book-1');

    await flushSchemaV2Store(app);
    expect(readV2Book(files, 'book-1').reading.lastPosition).toBeNull();
    await expect(service.loadReadingReferencePoint('book-1')).resolves.toBeNull();
  });

  it('retires legacy epub local data files into the unified weave-data store', async () => {
    const { app, files } = createMemoryApp({
      [`${SYNC_EPUB_ROOT}/books.json`]: JSON.stringify({
        'book-1': createBook(),
      }),
      [`${SYNC_EPUB_ROOT}/book-1/bookmarks.json`]: JSON.stringify([
        {
          id: 'bookmark-1',
          title: 'Legacy bookmark',
          chapterIndex: 1,
          cfi: 'epubcfi(/6/4!/4/2/2)',
          preview: 'Legacy bookmark',
          createdTime: 1710000000000,
        },
      ]),
      [`${SYNC_EPUB_ROOT}/book-1/state.json`]: JSON.stringify({
        currentPosition: {
          chapterIndex: 2,
          cfi: '/6/8',
          percent: 66,
        },
        readingStats: {
          totalReadTime: 12,
          lastReadTime: 222,
          createdTime: 111,
        },
      }),
      [`${SYNC_EPUB_ROOT}/reader-settings.desktop.json`]: JSON.stringify({
        lineHeight: 1.8,
        widthMode: 'standard',
        layoutMode: 'paginated',
        flowMode: 'paginated',
        showScrolledSideNav: true,
        footnoteClickAction: 'preview',
      }),
      [`${SYNC_EPUB_ROOT}/canvas-bindings.json`]: JSON.stringify({
        'book-1': 'Canvas/demo.canvas',
      }),
      [`${SYNC_EPUB_ROOT}/epub-source-registry.json`]: JSON.stringify([
        {
          sourceId: 'epubsrc-1',
          filePath: 'Books/demo.epub',
          lastSeenAt: 1710000000000,
        },
      ]),
      [`${SYNC_EPUB_ROOT}/epub-scan-index.json`]: JSON.stringify([
        {
          path: 'Books/demo.epub',
          name: 'demo',
          folder: 'Books',
          size: 1024,
          mtime: 1710000000000,
        },
      ]),
      [`${SYNC_EPUB_ROOT}/book-1/highlights.json`]: JSON.stringify([
        {
          id: 'highlight-legacy',
          text: 'legacy highlight',
          color: 'yellow',
          chapterIndex: 1,
          cfiRange: 'epubcfi(/6/4!/4/2/2)',
          createdTime: 444,
        },
      ]),
      [`${SYNC_EPUB_ROOT}/book-1/notes.json`]: JSON.stringify([
        {
          id: 'note-legacy',
          content: 'legacy note',
          quotedText: 'legacy quote',
          chapterIndex: 1,
          cfi: 'epubcfi(/6/4!/4/2/2)',
          createdTime: 555,
          modifiedTime: 555,
        },
      ]),
    });
    const service = new EpubStorageService(app);

    // 触发启动迁移/退役清理。
    await service.loadBooks({ hydrateStates: false });

    expect(files.has(`${SYNC_EPUB_ROOT}/books.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/book-1/bookmarks.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/book-1/state.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/book-1/highlights.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/book-1/notes.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/reader-settings.desktop.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/canvas-bindings.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/epub-source-registry.json`)).toBe(false);
    expect(files.has(`${SYNC_EPUB_ROOT}/epub-scan-index.json`)).toBe(false);
    // 统一数据现在只存在于 weave-data.json（无 epub-local-state.json）。
    expect(files.has(LOCAL_EPUB_DATA_PATH)).toBe(false);
  });

  it('loads bookshelf membership derived from schema v2 books aggregates', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: {
          'book-1': {
            id: 'book-1',
            file: { vaultPath: 'Books/demo.epub' },
            meta: createBook().metadata,
            reading: {
              position: { chapterIndex: 0, cfi: '', percent: 0 },
              stats: { totalReadTime: 0, lastReadTime: 0, createdTime: 0 },
            },
            notes: { bookmarks: [], highlights: [], excerpts: [] },
            audit: { createdAt: 100, updatedAt: 100 },
          },
        },
      }),
    }, ['Books/demo.epub']);

    const service = new EpubStorageService(app);

    await expect(service.loadBookshelfMembership()).resolves.toEqual([
      {
        path: 'Books/demo.epub',
        addedAt: 100,
      },
    ]);
    expect(files.has(LOCAL_EPUB_DATA_PATH)).toBe(false);
  });

  it('loads the bookshelf scan index derived from schema v2 books aggregates', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({
          'book-1': createBook({
            filePath: 'Books/demo.epub',
            metadata: { title: 'demo', author: 'Author', chapterCount: 3 },
          }),
        }),
      }),
    }, ['Books/demo.epub']);

    const service = new EpubStorageService(app);

    await expect(service.loadScanIndex()).resolves.toEqual([
      expect.objectContaining({
        path: 'Books/demo.epub',
        name: 'demo',
        folder: 'Books',
      }),
    ]);
    // Scan index is derived, no legacy cache file is written.
    expect(files.has(LOCAL_EPUB_SCAN_INDEX_PATH)).toBe(false);
  });

  it('refreshes folder bookshelf entries by scanning the folder directly', async () => {
    const { app, files } = createMemoryApp({}, ['Books/old.epub', 'Books/new.epub', 'Other/outside.epub']);

    const service = new EpubStorageService(app);
    const entries = await service.loadBookshelfEntriesForFolder('Books');
    await flushSchemaV2Store(app);
    const scanIndex = readShelfScanIndex(files);

    expect(entries.map((entry) => entry.path)).toEqual([
      'Books/new.epub',
      'Books/old.epub',
    ]);

    expect(scanIndex).toEqual([]);
  });

  it('keeps scanned EPUB files out of the bookshelf until the user adds membership', async () => {
    const { app, files } = createMemoryApp({}, ['Books/demo.epub', 'Books/other.epub']);

    const service = new EpubStorageService(app);
    const scanEntries = await service.scanVaultEpubs();
    const bookshelfEntries = await service.listBookshelfEntries();

    expect(scanEntries.map((entry) => entry.path)).toEqual(['Books/demo.epub', 'Books/other.epub']);
    expect(bookshelfEntries).toEqual([]);
    expect(readLocalEpubData(files).bookshelfMembership).toBeUndefined();
  });

  it('adds selected scanned EPUB files into the bookshelf (v2 aggregate) only once', async () => {
    const { app, files } = createMemoryApp({}, ['Books/demo.epub', 'Books/other.epub']);

    const service = new EpubStorageService(app);
    await service.scanVaultEpubs();
    await service.addBooksToBookshelf(['Books/demo.epub', 'Books/demo.epub']);
    const bookshelfEntries = await service.listBookshelfEntries();

    expect(bookshelfEntries.map((entry) => entry.path)).toEqual(['Books/demo.epub']);
    await flushSchemaV2Store(app);
    const books = await service.loadBooks({ hydrateStates: false });
    expect(Object.keys(books)).toHaveLength(1);
    expect(Object.values(books).some((book) => book.filePath === 'Books/demo.epub')).toBe(true);
    expect(Object.values(books).some((book) => book.filePath === 'Books/other.epub')).toBe(false);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(
      Object.values(parsed.books ?? {}).some(
        (aggregate: any) => aggregate?.file?.vaultPath === 'Books/demo.epub'
      )
    ).toBe(true);
  });

  it('only keeps scan results that resolve to a vault book file', async () => {
    const { app } = createMemoryApp({}, ['Books/demo.epub', 'Archive/demo.epub']);

    const service = new EpubStorageService(app);
    const entries = await service.scanVaultBooks();

    expect(entries.map((entry) => entry.path).sort()).toEqual(
      ['Archive/demo.epub', 'Books/demo.epub'].sort()
    );
  });

  it('adds books to bookshelf using canonical vault paths', async () => {
    const { app, files } = createMemoryApp({}, ['Books/demo.epub']);

    const service = new EpubStorageService(app);
    const added = await service.addBooksToBookshelf(['demo.epub']);

    expect(added).toEqual([{ path: 'Books/demo.epub', addedAt: expect.any(Number) }]);
    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(
      Object.values(parsed.books ?? {}).some(
        (aggregate: any) => aggregate?.file?.vaultPath === 'Books/demo.epub'
      )
    ).toBe(true);
    await expect(service.listBookshelfEntries()).resolves.toEqual([
      expect.objectContaining({ path: 'Books/demo.epub' }),
    ]);
  });

  it('scans only visible vault-indexed books and ignores trash paths', async () => {
    const { app } = createMemoryApp({}, ['Books/visible.epub', '.trash/deleted.epub']);

    const service = new EpubStorageService(app);
    const entries = await service.scanVaultBooks();

    expect(entries.map((entry) => entry.path)).toEqual(['Books/visible.epub']);
  });

  it('scan results are not persisted into any scan index (v2 books only)', async () => {
    const { app, files } = createMemoryApp({}, ['Books/visible.epub']);

    const service = new EpubStorageService(app);
    const entries = await service.scanVaultBooks();

    expect(entries.map((entry) => entry.path)).toEqual(['Books/visible.epub']);
    await flushSchemaV2Store(app);
    expect(readShelfScanIndex(files)).toEqual([]);
    expect(files.has(LOCAL_EPUB_DATA_PATH)).toBe(false);
  });

  it('prunes stale book aggregates when missing files are explicitly cleaned up', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({
          'book-1': createBook({ filePath: 'Books/missing.epub' }),
        }),
      }),
    });

    const service = new EpubStorageService(app);
    await service.pruneMissingBooks();

    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(Object.keys(parsed.books ?? {})).toEqual([]);
    await expect(service.listBookshelfEntries()).resolves.toEqual([]);
  });

  it('removeMissingBookshelfEntry clears the book aggregate for a missing file', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({
          'book-1': createBook({ filePath: 'Books/missing.epub' }),
        }),
      }),
    });

    const service = new EpubStorageService(app);
    await service.removeMissingBookshelfEntry('Books/missing.epub');

    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(Object.keys(parsed.books ?? {})).toEqual([]);
    await expect(service.listBookshelfEntries()).resolves.toEqual([]);
  });

  it('updateBookDisplayTitle persists renamed metadata for later loads', async () => {
    const { app } = createMemoryApp({}, ['Books/demo.epub']);
    const service = new EpubStorageService(app);
    const book = createBook({
      id: 'book-rename',
      filePath: 'Books/demo.epub',
      metadata: {
        title: '旧书名',
        author: '作者',
        chapterCount: 3,
      },
    });

    await service.saveBook(book);
    const renamed = await service.updateBookDisplayTitle({
      ...book,
      metadata: {
        ...book.metadata,
        title: '新书名',
      },
    });

    expect(renamed.metadata.title).toBe('新书名');
    const reloaded = await service.findBookByFilePath('Books/demo.epub');
    expect(reloaded?.metadata.title).toBe('新书名');
  });

  it('does not restore bookshelf membership when saving book state after removing it from the bookshelf', async () => {
    const { app } = createMemoryApp({}, ['Books/demo.epub']);

    const service = new EpubStorageService(app);
    await service.scanVaultBooks();
    await service.addBooksToBookshelf(['Books/demo.epub']);
    await service.removeFromBookshelfByFilePath('Books/demo.epub', { purgeCache: true });

    await service.saveBook(createBook({
      id: 'book-2',
      filePath: 'Books/demo.epub',
    }));

    const books = await service.loadBooks({ hydrateStates: false });
    expect(Object.keys(books)).toEqual(['book-2']);
    expect(books['book-2']?.filePath).toBe('Books/demo.epub');
    expect(await service.listBookshelfEntries()).toEqual([
      expect.objectContaining({ path: 'Books/demo.epub' }),
    ]);
  });

  it('does not let another storage instance rewrite stale bookshelf membership back into unified local data', async () => {
    const { app } = createMemoryApp({}, ['Books/demo.epub']);

    const serviceA = new EpubStorageService(app);
    const serviceB = new EpubStorageService(app);

    await serviceA.scanVaultBooks();
    await serviceA.addBooksToBookshelf(['Books/demo.epub']);
    await expect(serviceB.loadBookshelfMembership()).resolves.toEqual([
      expect.objectContaining({ path: 'Books/demo.epub' }),
    ]);

    await serviceA.removeFromBookshelfByFilePath('Books/demo.epub', { purgeCache: true });
    await serviceB.scanVaultBooks();

    const reloadedService = new EpubStorageService(app);
    await flushSchemaV2Store(app);

    await expect(reloadedService.loadBookshelfMembership()).resolves.toEqual([]);
    await expect(reloadedService.listBookshelfEntries()).resolves.toEqual([]);
  });

  it('persists bookshelf custom cover paths across reload', async () => {
    const { app, files } = createMemoryApp({}, ['Books/demo.epub', 'Assets/cover.png']);
    const service = new EpubStorageService(app);

    await service.addBooksToBookshelf(['Books/demo.epub']);
    await expect(service.setBookshelfCustomCover('Books/demo.epub', 'Assets/cover.png')).resolves.toBe(true);

    await expect(service.loadBookshelfMembership()).resolves.toEqual([
      expect.objectContaining({
        path: 'Books/demo.epub',
        customCoverPath: 'Assets/cover.png',
      }),
    ]);

    const reloadedService = new EpubStorageService(app);
    await expect(reloadedService.loadBookshelfMembership()).resolves.toEqual([
      expect.objectContaining({
        path: 'Books/demo.epub',
        customCoverPath: 'Assets/cover.png',
      }),
    ]);
    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    const aggregates = Object.values(parsed.books ?? {}) as Array<{ ui?: Record<string, unknown> }>;
    expect(aggregates.some((aggregate) => aggregate?.ui?.customCoverPath === 'Assets/cover.png')).toBe(true);
  });

  it('keeps explicit empty membership authoritative (v2 books are the only source)', async () => {
    const { app, files } = createMemoryApp({}, ['Books/demo.epub']);

    const service = new EpubStorageService(app);
    await service.addBooksToBookshelf(['Books/demo.epub']);
    await expect(service.loadBookshelfMembership()).resolves.toEqual([
      expect.objectContaining({ path: 'Books/demo.epub' }),
    ]);

    // v2：saveBookshelfMembership 为 no-op（membership 收敛于 books 聚合）
    await service.saveBookshelfMembership([]);
    await service.removeFromBookshelfByFilePath('Books/demo.epub', { purgeCache: true });

    await flushSchemaV2Store(app);
    const reloadedService = new EpubStorageService(app);

    await expect(reloadedService.loadBookshelfMembership()).resolves.toEqual([]);
    await expect(reloadedService.listBookshelfEntries()).resolves.toEqual([]);
    expect(files.has(`${SYNC_EPUB_ROOT}/bookshelf-membership.json`)).toBe(false);
  });

  it('updates book aggregate vault path when an EPUB file is renamed', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({ 'book-1': createBook({ filePath: 'Books/old.epub' }) }),
      }),
    }, ['Books/new.epub']);

    const service = new EpubStorageService(app);
    const updated = await service.updateBookFileReferences('Books/old.epub', 'Books/new.epub');
    await flushSchemaV2Store(app);

    expect(updated).toBe(1);
    const aggregate = readV2Book(files, 'book-1');
    expect(aggregate.file.vaultPath).toBe('Books/new.epub');
    expect(aggregate.file.legacyPaths).toEqual(['Books/old.epub']);
    const book = await service.findBookByFilePath('Books/new.epub');
    expect(book?.filePath).toBe('Books/new.epub');
    expect(book?.id).toBeTruthy();
  });

  it('removes the book aggregate by file path for reimport', async () => {
    const booksPath = `${SYNC_EPUB_ROOT}/books.json`;
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({ 'book-1': createBook() }),
      }),
    }, ['Books/demo.epub']);

    const service = new EpubStorageService(app);
    const result = await service.removeBookByFilePath('Books/demo.epub');
    const reloadedService = new EpubStorageService(app);

    expect(result.removedBookId).toBe('book-1');
    expect(files.has(booksPath)).toBe(false);
    await flushSchemaV2Store(app);
    expect(Object.keys(readV2Book(files, 'book-1') ?? {})).toEqual([]);
    expect(readShelfScanIndex(files)).toEqual([]);
    await expect(reloadedService.getBook('book-1')).resolves.toBeNull();
    await expect(reloadedService.listBookshelfEntries()).resolves.toEqual([]);
  });

  it('deletes the tracked book file and removes its aggregate', async () => {
    const booksPath = `${SYNC_EPUB_ROOT}/books.json`;
    const { app, files, vaultFiles } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({ 'book-1': createBook({ sourceId: 'epubsrc-demo' }) }),
      }),
    }, ['Books/demo.epub'], {
      'Books/demo.epub': 'binary-epub',
    });

    const service = new EpubStorageService(app);
    const result = await service.deleteTrackedBookFile('Books/demo.epub');
    const reloadedService = new EpubStorageService(app);

    expect(result.fileDeleted).toBe(true);
    expect(result.deletedFilePath).toBe('Books/demo.epub');
    expect(result.removedBookIds).toEqual(['book-1']);
    expect(app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(vaultFiles.has('Books/demo.epub')).toBe(false);
    await flushSchemaV2Store(app);
    expect(readShelfScanIndex(files)).toEqual([]);
    expect(await reloadedService.listBookshelfEntries()).toEqual([]);
    await expect(reloadedService.findBookByFilePath('Books/demo.epub')).resolves.toBeNull();
    await expect(reloadedService.listBookshelfEntries()).resolves.toEqual([]);
  });

  it('reuses the same source identity after the same epub is re-added under a new path', async () => {
    const { app, files, vaultFiles } = createMemoryApp({}, ['Books/demo.epub'], {
      'Books/demo.epub': 'same-binary-epub',
      'Library/demo-renamed.epub': 'same-binary-epub',
    });

    const service = new EpubStorageService(app);
    const firstBook = createBook({ filePath: 'Books/demo.epub' });
    await service.saveBook(firstBook);

    const firstSourceId = (await service.findBookByFilePath('Books/demo.epub'))?.sourceId;
    expect(firstSourceId).toBeTruthy();

    vaultFiles.delete('Books/demo.epub');
    vaultFiles.add('Library/demo-renamed.epub');

    await service.pruneMissingBooks();

    const reimportedBook = createBook({
      id: 'book-2',
      filePath: 'Library/demo-renamed.epub',
      readingStats: {
        totalReadTime: 0,
        lastReadTime: 200,
        createdTime: 200,
      },
    });
    await service.saveBook(reimportedBook);

    const reimported = await service.findBookByFilePath('Library/demo-renamed.epub');
    expect(reimported?.sourceId).toBe(firstSourceId);
    await expect(service.resolveSourceFilePath(firstSourceId || '')).resolves.toBe(
      'Library/demo-renamed.epub'
    );
  });

  it('generates a deterministic sourceId from sourceFingerprint for the same epub binary', async () => {
    const binaryContent = 'same-binary-epub';
    const { app } = createMemoryApp({}, ['Books/demo.epub'], {
      'Books/demo.epub': binaryContent,
    });
    const service = new EpubStorageService(app);

    await service.saveBook(createBook({ id: 'book-a' }));

    const savedBook = await service.findBookByFilePath('Books/demo.epub');
    const fingerprintBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(binaryContent)
    );
    const fingerprint = Array.from(new Uint8Array(fingerprintBuffer))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');

    expect(savedBook?.sourceFingerprint).toBe(fingerprint);
    expect(savedBook?.sourceId).toBe(`epubsrc-${fingerprint.slice(0, 24)}`);
  });

  it('replaces ephemeral runtime book ids with a stable book id and reuses it for the same source', async () => {
    const binaryContent = 'same-binary-epub';
    const { app, files } = createMemoryApp({}, ['Books/demo.epub'], {
      'Books/demo.epub': binaryContent,
    });
    const service = new EpubStorageService(app);

    await service.saveBook(createBook({ id: 'epub-ab12cd' }));
    const firstSavedBook = await service.findBookByFilePath('Books/demo.epub');

    await service.saveBook(createBook({ id: 'epub-ef34gh', readingStats: {
      totalReadTime: 0,
      lastReadTime: 200,
      createdTime: 200,
    } }));
    const secondSavedBook = await service.findBookByFilePath('Books/demo.epub');
    const books = await service.loadBooks({ hydrateStates: false });

    expect(firstSavedBook?.id).toMatch(/^epub-book-/);
    expect(secondSavedBook?.id).toBe(firstSavedBook?.id);
    expect(Object.keys(books)).toEqual([firstSavedBook?.id]);
  });

  it('findBookByFilePath avoids eager batch catalog hydration', async () => {
    const { app, files } = createMemoryApp(
      {
        'Books/demo.epub': 'demo-epub-binary',
      },
      ['Books/demo.epub']
    );
    const service = new EpubStorageService(app);
    await service.addBooksToBookshelf(['Books/demo.epub']);
    const hydrateSpy = vi.spyOn(service as any, 'hydrateBookStates');

    const book = await service.findBookByFilePath('Books/demo.epub');

    expect(book?.filePath).toBe('Books/demo.epub');
    expect(hydrateSpy).not.toHaveBeenCalled();
    hydrateSpy.mockRestore();
    const membership =
      readLocalEpubData(files).bookshelfMembership ||
      (await service.loadBookshelfMembership());
    expect(membership?.length).toBeGreaterThan(0);
  });

  it('persists bookshelf search query in plugin ui memory across reloads', async () => {
    const { app, files } = createMemoryApp();
    const service = new EpubStorageService(app);

    await service.saveBookshelfSearchQuery('author:"鲍曼"');
    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(parsed.uiMemory?.bookshelfSearchQuery).toBe('author:"鲍曼"');

    const reloaded = new EpubStorageService(app);
    await expect(reloaded.loadBookshelfSearchQuery()).resolves.toBe('author:"鲍曼"');

    await reloaded.saveBookshelfSearchQuery('   ');
    await flushSchemaV2Store(app);
    const parsed2 = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(parsed2.uiMemory?.bookshelfSearchQuery).toBe('');
    await expect(reloaded.loadBookshelfSearchQuery()).resolves.toBe('');
  });

  it('waits for in-flight automatic migrations before concurrent loadBooks calls proceed', async () => {
    const { app } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 1,
          updatedAt: 1,
          bookshelfMembership: [{ path: 'Books/demo.epub', addedAt: 1 }],
          books: {},
        }),
      },
      ['Books/demo.epub'],
      { 'Books/demo.epub': 'demo-epub-binary' }
    );
    const service = new EpubStorageService(app);
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const retireSpy = vi
      .spyOn(service as unknown as { retireLegacyStorageFiles: () => Promise<void> }, 'retireLegacyStorageFiles')
      .mockImplementationOnce(async () => {
        await migrationGate;
      });

    const firstLoad = service.loadBooks({ hydrateStates: false });
    await Promise.resolve();
    const secondLoad = service.loadBooks({ hydrateStates: false });

    expect((service as unknown as { automaticMigrationCompleted: boolean }).automaticMigrationCompleted).toBe(
      false
    );

    releaseMigration();
    await Promise.all([firstLoad, secondLoad]);

    expect(retireSpy).toHaveBeenCalledTimes(1);
    expect((service as unknown as { automaticMigrationCompleted: boolean }).automaticMigrationCompleted).toBe(
      true
    );
    retireSpy.mockRestore();
  });

  it('loads reading progress from the persisted aggregate via book id', async () => {
    const bookPath = 'Books/demo.epub';
    const { app } = createMemoryApp(
      {
        [WEAVE_DATA_FILE]: JSON.stringify({
          schemaVersion: 2,
          books: toV2StoreBooks({
            'book-1': createBook({
              currentPosition: { chapterIndex: 1, cfi: '/6/6', percent: 42 },
            }),
          }),
        }),
      },
      [bookPath]
    );
    const service = new EpubStorageService(app);

    const progress = await service.loadProgress('book-1');

    expect(progress?.percent).toBe(42);
    expect(progress?.cfi).toBe('/6/6');
  });

  it('stores paragraph mode positions in the schema v2 book ui memory', async () => {
    const { app, files } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({ 'book-1': createBook() }),
      }),
    });
    const service = new EpubStorageService(app);

    await service.saveParagraphModeReadingPosition({
      bookId: 'book-1',
      filePath: 'Books/demo.epub',
      bookTitle: 'Demo',
      chapterTitle: 'Chapter 2',
      chapterHref: 'chapter-2.xhtml',
      chapterIndex: 2,
      cfi: 'epubcfi(/6/6!/4/2,/1:0,/1:10)',
      percent: 24,
      paragraphId: '2:0:def',
      paragraphIndex: 0,
      paragraphTextPreview: 'Updated preview',
      savedAt: 2234567890,
    });

    const updated = await service.loadParagraphModeReadingPosition('book-1');
    expect(updated?.chapterTitle).toBe('Chapter 2');
    expect(updated?.cfi).toBe('epubcfi(/6/6!/4/2,/1:0,/1:10)');

    await flushSchemaV2Store(app);
    const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) || '{}');
    expect(parsed.books['book-1'].ui.paragraphModePosition.paragraphId).toBe('2:0:def');
    expect(files.has(LOCAL_EPUB_PARAGRAPH_MODE_POSITIONS_PATH)).toBe(false);
  });

  it('returns null paragraph mode position for unknown books', async () => {
    const { app } = createMemoryApp({
      [WEAVE_DATA_FILE]: JSON.stringify({
        schemaVersion: 2,
        books: toV2StoreBooks({ 'book-1': createBook() }),
      }),
    });
    const service = new EpubStorageService(app);

    await expect(service.loadParagraphModeReadingPosition('missing')).resolves.toBeNull();
  });
});
