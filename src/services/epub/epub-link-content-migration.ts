import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import { showObsidianConfirm } from "../../utils/obsidian-confirm";
import { EpubLinkService } from "./EpubLinkService";

const promptedMigrationPaths = new Set<string>();
const declinedMigrationPaths = new Set<string>();

export async function maybeMigrateEpubLinksInMarkdownFile(
	app: App,
	sourceFile: TFile,
	originalContent: string
): Promise<void> {
	const sourcePath = sourceFile.path;
	if (declinedMigrationPaths.has(sourcePath) || promptedMigrationPaths.has(sourcePath)) {
		return;
	}

	const legacyLinkCount = EpubLinkService.countLegacyEpubLinkMarkups(originalContent);
	if (legacyLinkCount <= 0) {
		await applyEpubLinkContentMigration(app, sourceFile, originalContent, { silent: true });
		return;
	}

	promptedMigrationPaths.add(sourcePath);

	const fileLabel = sourceFile.basename || sourcePath;
	const confirmed = await showObsidianConfirm(
		app,
		`「${fileLabel}」中有 ${legacyLinkCount} 条旧式 EPUB 溯源链接（URL 内嵌全文，编辑不便）。\n\n确认后将移除链接中的正文参数并压缩定位信息；callout 引用正文不会改动。`,
		{
			title: '缩短 EPUB 溯源链接',
			confirmText: '确认迁移',
			cancelText: '暂不',
		}
	);

	if (!confirmed) {
		declinedMigrationPaths.add(sourcePath);
		return;
	}

	const migrated = await applyEpubLinkContentMigration(app, sourceFile, originalContent, {
		silent: false,
	});
	if (migrated) {
		new Notice(
			`已更新「${fileLabel}」中的 ${legacyLinkCount} 条 EPUB 溯源链接`
		);
	}
}

async function applyEpubLinkContentMigration(
	app: App,
	sourceFile: TFile,
	originalContent: string,
	options: { silent: boolean }
): Promise<boolean> {
	try {
		const linkService = new EpubLinkService(app);
		const migration = await linkService.enrichEpubLinksWithSourceIdsInContent(
			originalContent,
			sourceFile.path
		);
		if (!migration.changed || migration.content === originalContent) {
			return false;
		}
		await app.vault.process(sourceFile, (content) =>
			content === originalContent ? migration.content : content
		);
		return true;
	} catch {
		if (!options.silent) {
			new Notice('EPUB 溯源链接迁移失败');
		}
		return false;
	}
}

/** Resets in-memory migration prompt state (for tests). */
export function resetEpubLinkMigrationPromptStateForTests(): void {
	promptedMigrationPaths.clear();
	declinedMigrationPaths.clear();
}
