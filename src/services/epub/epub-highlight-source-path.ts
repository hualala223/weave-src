import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import {
	getPluginEditorTempDir,
	getVaultEditorTempDir,
	isDetachedEditorTempFilePath,
	isLegacyModalEditorPermanentFilePath,
	isModalEditorPermanentFilePath,
	isPluginCacheModalEditorPermanentFilePath,
} from "../editor/editor-temp-file-policy";
import { unknownPlainText } from "../../utils/unknown-plain-text";
import { isSupportedBookPath } from "./book-format";

/**
 * 已持久化的卡片/摘录来源（溯源只读侧）。
 * 记忆卡片桥接已移除，但仍需读取 vault 中既有卡片数据以支持双向溯源。
 */
export type EpubHighlightPersistenceSourceCandidate = {
	uuid?: string;
	deckId?: string;
	sourceFile?: string;
	customFields?: Record<string, unknown>;
};

const WDECK_PERSISTENCE_FIELD = "wdeck" as const;

/**
 * Modal / detached editor buffers are not persisted excerpt sources.
 * They must never drive EPUB reader highlight aggregation.
 */
export function isEphemeralEditorHighlightSourcePath(
	app: App,
	path?: string | null
): boolean {
	const normalizedPath = normalizePath(String(path || "").trim());
	if (!normalizedPath) {
		return false;
	}

	const fileName = normalizedPath.split("/").pop() || "";
	if (isModalEditorPermanentFilePath(normalizedPath) || isModalEditorPermanentFilePath(fileName)) {
		return true;
	}
	if (isDetachedEditorTempFilePath(normalizedPath)) {
		return true;
	}
	if (isLegacyModalEditorPermanentFilePath(normalizedPath)) {
		return true;
	}
	if (isPluginCacheModalEditorPermanentFilePath(app, normalizedPath)) {
		return true;
	}

	const vaultEditorTempDir = getVaultEditorTempDir(app);
	if (
		vaultEditorTempDir &&
		(normalizedPath === vaultEditorTempDir || normalizedPath.startsWith(`${vaultEditorTempDir}/`))
	) {
		return true;
	}

	const pluginEditorTempDir = getPluginEditorTempDir(app);
	if (
		pluginEditorTempDir &&
		(normalizedPath === pluginEditorTempDir || normalizedPath.startsWith(`${pluginEditorTempDir}/`))
	) {
		return true;
	}

	return false;
}

export function isEpubDocumentSourcePath(path?: string | null): boolean {
	return isSupportedBookPath(normalizePath(String(path || "").trim()));
}

export function isPersistedExcerptStorageSourcePath(path?: string | null): boolean {
	const normalizedPath = normalizePath(String(path || "").trim());
	if (!normalizedPath || isEpubDocumentSourcePath(normalizedPath)) {
		return false;
	}
	const lower = normalizedPath.toLowerCase();
	return (
		lower.endsWith(".md") ||
		lower.endsWith(".canvas") ||
		lower.endsWith(".wdeck") ||
		lower.endsWith(".json")
	);
}

/**
 * 解析摘录内容持久化的物理 vault 文件（`.wdeck` / card json / md / canvas）。
 */
export function resolveEpubHighlightPersistenceSourcePath(
	card: EpubHighlightPersistenceSourceCandidate
): string | undefined {
	const wdeckValue = card.customFields?.[WDECK_PERSISTENCE_FIELD];
	const wdeckMeta =
		wdeckValue && typeof wdeckValue === "object" ? (wdeckValue as { sourcePath?: unknown }) : null;
	const wdeckSourcePath = normalizePath(unknownPlainText(wdeckMeta?.sourcePath).trim());
	if (wdeckSourcePath && isPersistedExcerptStorageSourcePath(wdeckSourcePath)) {
		return wdeckSourcePath;
	}

	const sourceFile = normalizePath(String(card.sourceFile || "").trim());
	if (sourceFile && isPersistedExcerptStorageSourcePath(sourceFile)) {
		return sourceFile;
	}

	return undefined;
}
