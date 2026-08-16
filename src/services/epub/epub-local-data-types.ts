import type { EpubBookshelfMembershipEntry } from "./epub-bookshelf-membership-store";
import type { EpubBookshelfPlaylist } from "./epub-bookshelf-playlist-store";
import type { EpubExcerptSettings } from "./epub-excerpt-settings";
import type { EpubReaderSettingsDeviceKind } from "./reader-settings";
import type {
	BookMetadata,
	EpubBook,
	EpubLastOpenBookmark,
	EpubReadingReferencePoint,
	EpubReaderSettings,
} from "./types";
export interface EpubPluginUiMemory {
	selectionQuickCreateLastFolder: string;
	bookshelfSearchQuery: string;
}

export interface EpubBookshelfIndexEntry {
	path: string;
	name: string;
	folder: string;
	size: number;
	addedAt?: number;
	customCoverPath?: string;
}

export interface EpubScanIndexEntry extends EpubBookshelfIndexEntry {
	mtime: number;
	coverImage?: string;
}

export interface EpubSourceRegistryEntry {
	sourceId: string;
	filePath: string;
	sourceFingerprint?: string;
	legacySourceIds?: string[];
	sourceSize?: number;
	sourceMtime?: number;
	lastSeenAt: number;
	lastKnownPath?: string;
}

export interface EpubStoredBookDescriptor {
	id: string;
	filePath: string;
	sourceId?: string;
	sourceFingerprint?: string;
	sourceMtime?: number;
	sourceSize?: number;
	metadata: BookMetadata;
}

export interface EpubReaderLocalBookRecord {
	descriptor?: EpubStoredBookDescriptor;
	state?: Pick<EpubBook, "currentPosition" | "readingStats">;
	lastOpenBookmark?: EpubLastOpenBookmark | null;
	readingReferencePoint?: EpubReadingReferencePoint | null;
}

export interface EpubReaderLocalDataFile {
	version: 1;
	updatedAt: number;
	bookCatalogStoredLocally?: boolean;
	uiMemory?: EpubPluginUiMemory;
	readerSettings?: Partial<Record<EpubReaderSettingsDeviceKind, EpubReaderSettings>>;
	excerptSettings?: EpubExcerptSettings;
	scanIndex?: EpubScanIndexEntry[];
	bookshelfMembership?: EpubBookshelfMembershipEntry[];
	bookshelfPlaylists?: EpubBookshelfPlaylist[];
	sourceRegistry?: EpubSourceRegistryEntry[];
	books?: Record<string, EpubReaderLocalBookRecord>;
}
