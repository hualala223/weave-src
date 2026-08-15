import { Modal, type App, setIcon } from "obsidian";
import type { BookMetadata, ReadingStats } from "../../services/epub";

type EpubBookInfoNoteStats = {
	totalHighlights: number;
	commentCount: number;
	sourceFileCount: number;
	available: boolean;
};

type EpubBookInfoModalOptions = {
	filePath: string;
	fileName: string;
	fileSize: number;
	metadata: BookMetadata;
	progress: number;
	readingStats?: ReadingStats | null;
	noteStats?: EpubBookInfoNoteStats | null;
};

type BookInfoField = {
	label: string;
	value: string;
	wide?: boolean;
	multiline?: boolean;
	mono?: boolean;
};

type BookInfoListField = {
	label: string;
	value: string;
	multiline?: boolean;
	mono?: boolean;
};

type BookInfoStatField = {
	label: string;
	value: string;
};

function formatNumber(value: number | undefined): string {
	if (!Number.isFinite(value)) {
		return "";
	}
	return new Intl.NumberFormat("zh-CN").format(value as number);
}

function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDateTime(timestamp: number | undefined): string {
	if (!Number.isFinite(timestamp) || !timestamp || timestamp <= 0) {
		return "";
	}
	return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function formatPublishDate(value: string | undefined): string {
	const normalizedValue = normalizeText(value);
	if (!normalizedValue) {
		return "";
	}
	const match = normalizedValue.match(
		/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T\s].*)?$/
	);
	if (!match) {
		return normalizedValue;
	}
	const [, year, month, day] = match;
	if (!day) {
		return `${year}-${month.padStart(2, "0")}`;
	}
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatDuration(durationMs: number | undefined): string {
	if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) {
		return "";
	}
	const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours <= 0) {
		return `${minutes} 分钟`;
	}
	if (minutes <= 0) {
		return `${hours} 小时`;
	}
	return `${hours} 小时 ${minutes} 分钟`;
}

function normalizeProgress(progress: number): number {
	if (!Number.isFinite(progress)) {
		return 0;
	}
	return Math.max(0, Math.min(100, Math.round(progress)));
}

function normalizeText(value: string | undefined): string {
	return String(value || "").trim();
}

export class EpubBookInfoModal extends Modal {
	private readonly options: EpubBookInfoModalOptions;

	constructor(app: App, options: EpubBookInfoModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.modalEl.addClass("weave-epub-book-info-modal");
		this.titleEl.setText('书籍完整信息');
		this.contentEl.empty();
		this.buildLayout();
	}

	onClose(): void {
		this.modalEl.removeClass("weave-epub-book-info-modal");
		this.contentEl.empty();
	}

	private buildLayout(): void {
		const shell = this.contentEl.createDiv({ cls: "weave-epub-book-info-shell" });
		this.buildHero(shell);
		this.buildSections(shell);
	}

	private buildHero(container: HTMLElement): void {
		const hero = container.createDiv({ cls: "weave-epub-book-info-hero" });
		hero.createDiv({
			cls: "weave-epub-book-info-title",
			text:
				this.options.metadata.title ||
				this.options.fileName ||
				'未命名书籍',
		});
		const heroBody = hero.createDiv({ cls: "weave-epub-book-info-hero-body" });
		const coverUrl = normalizeText(this.options.metadata.coverImage);
		if (coverUrl) {
			heroBody.createEl("img", {
				cls: "weave-epub-book-info-cover",
				attr: {
					src: coverUrl,
					alt: this.options.metadata.title || this.options.fileName,
				},
			});
		} else {
			const placeholder = heroBody.createDiv({ cls: "weave-epub-book-info-cover is-placeholder" });
			const iconEl = placeholder.createSpan({ cls: "weave-epub-book-info-cover-icon" });
			setIcon(iconEl, "book-open");
		}

		const content = heroBody.createDiv({ cls: "weave-epub-book-info-hero-content" });
		const introBookFields = this.buildIntroBookFields();
		if (introBookFields.length > 0) {
			this.renderListFields(content, introBookFields, "weave-epub-book-info-list is-intro");
			return;
		}

		const bylineParts = [
			normalizeText(this.options.metadata.author),
			normalizeText(this.options.metadata.translator)
				? `译者：${normalizeText(this.options.metadata.translator)}`
				: "",
		].filter(Boolean);
		if (bylineParts.length > 0) {
			content.createDiv({
				cls: "weave-epub-book-info-byline",
				text: bylineParts.join(" · "),
			});
		}
	}

	private buildSections(container: HTMLElement): void {
		const sections = container.createDiv({ cls: "weave-epub-book-info-sections" });
		const readingFields = this.buildReadingFields();
		const fileFields = this.buildFileFields();
		this.renderNoteStatsSection(sections);
		if (readingFields.length > 0) {
			this.renderFieldSection(sections, '阅读信息', readingFields);
		}
		this.renderListSection(sections, '文件信息', fileFields);
		const description = normalizeText(this.options.metadata.description);
		if (description) {
			this.renderTextSection(sections, '内容简介', description);
		}
	}

	private buildIntroBookFields(): BookInfoListField[] {
		const metadata = this.options.metadata;
		const isbn = normalizeText(metadata.isbn);
		const identifier = normalizeText(metadata.identifier);
		return [
			{ label: '作者', value: normalizeText(metadata.author) },
			{
				label: '译者',
				value: normalizeText(metadata.translator),
			},
			{
				label: '出版社',
				value: normalizeText(metadata.publisher),
			},
			{
				label: '出版年',
				value: formatPublishDate(metadata.publishDate),
			},
			{ label: "ISBN", value: isbn, mono: true },
			{
				label: '标识符',
				value: identifier && identifier !== isbn ? identifier : "",
				mono: true,
			},
			{ label: '系列', value: normalizeText(metadata.series) },
			{
				label: '章节数',
				value:
					metadata.chapterCount > 0
						? `${formatNumber(metadata.chapterCount)} 章`
						: "",
			},
			{
				label: '字数',
				value: metadata.wordCount
					? `${formatNumber(metadata.wordCount)} 字`
					: "",
			},
			{ label: '定价', value: normalizeText(metadata.price) },
			{
				label: '主题',
				value: Array.isArray(metadata.subjects) ? metadata.subjects.filter(Boolean).join(" / ") : "",
				multiline: true,
			},
			{
				label: '版权',
				value: normalizeText(metadata.rights),
				multiline: true,
			},
		].filter((field) => field.value);
	}

	private buildReadingFields(): BookInfoField[] {
		const stats = this.options.readingStats;
		const fields: BookInfoField[] = [
			{
				label: '阅读进度',
				value: `${normalizeProgress(this.options.progress)}%`,
			},
			{
				label: '最近阅读',
				value: formatDateTime(stats?.lastReadTime),
			},
			{
				label: '累计阅读',
				value: formatDuration(stats?.totalReadTime),
			},
			{
				label: '首次记录',
				value: formatDateTime(stats?.createdTime),
			},
			{
				label: '读完时间',
				value: formatDateTime(stats?.completedTime),
			},
		];
		return fields.filter((field) => field.value);
	}

	private buildFileFields(): BookInfoListField[] {
		return [
			{
				label: '文件大小',
				value: formatFileSize(this.options.fileSize),
			},
			{
				label: '存放路径',
				value: this.options.filePath,
				multiline: true,
				mono: true,
			},
		].filter((field) => field.value);
	}

	private buildNoteStatsFields(): BookInfoStatField[] {
		const stats = this.options.noteStats;
		if (!stats?.available) {
			return [];
		}
		return [
			{
				label: '摘录总数',
				value: formatNumber(stats.totalHighlights) || "0",
			},
			{
				label: '含想法摘录',
				value: formatNumber(stats.commentCount) || "0",
			},
			{
				label: '来源文件',
				value: formatNumber(stats.sourceFileCount) || "0",
			},
		];
	}

	private renderNoteStatsSection(container: HTMLElement): void {
		const stats = this.options.noteStats;
		if (!stats) {
			return;
		}
		const section = container.createDiv({ cls: "weave-epub-book-info-section" });
		section.createDiv({
			cls: "weave-epub-book-info-section-title",
			text: '笔记统计',
		});
		if (!stats.available) {
			section.createDiv({
				cls: "weave-epub-book-info-note",
				text: '当前暂时无法完成笔记统计。',
			});
			return;
		}
		const statFields = this.buildNoteStatsFields();
		if (statFields.length === 0) {
			return;
		}
		const statsGrid = section.createDiv({ cls: "weave-epub-book-info-stats" });
		for (const field of statFields) {
			const item = statsGrid.createDiv({ cls: "weave-epub-book-info-stat" });
			item.createDiv({ cls: "weave-epub-book-info-stat-value", text: field.value });
			item.createDiv({ cls: "weave-epub-book-info-stat-label", text: field.label });
		}
	}

	private renderFieldSection(container: HTMLElement, title: string, fields: BookInfoField[]): void {
		if (fields.length === 0) {
			return;
		}
		const section = container.createDiv({ cls: "weave-epub-book-info-section" });
		section.createDiv({ cls: "weave-epub-book-info-section-title", text: title });
		const grid = section.createDiv({ cls: "weave-epub-book-info-grid" });
		for (const field of fields) {
			const item = grid.createDiv({ cls: "weave-epub-book-info-item" });
			if (field.wide) {
				item.addClass("is-wide");
			}
			if (field.multiline) {
				item.addClass("is-multiline");
			}
			if (field.mono) {
				item.addClass("is-mono");
			}
			item.createDiv({ cls: "weave-epub-book-info-label", text: field.label });
			item.createDiv({ cls: "weave-epub-book-info-value", text: field.value });
		}
	}

	private renderListSection(container: HTMLElement, title: string, fields: BookInfoListField[]): void {
		if (fields.length === 0) {
			return;
		}
		const section = container.createDiv({ cls: "weave-epub-book-info-section" });
		section.createDiv({ cls: "weave-epub-book-info-section-title", text: title });
		this.renderListFields(section, fields);
	}

	private renderListFields(
		container: HTMLElement,
		fields: BookInfoListField[],
		listClass = "weave-epub-book-info-list"
	): void {
		const list = container.createDiv({ cls: listClass });
		for (const field of fields) {
			const row = list.createDiv({ cls: "weave-epub-book-info-list-row" });
			if (field.multiline) {
				row.addClass("is-multiline");
			}
			if (field.mono) {
				row.addClass("is-mono");
			}
			row.createDiv({ cls: "weave-epub-book-info-list-label", text: field.label });
			row.createDiv({ cls: "weave-epub-book-info-list-value", text: field.value });
		}
	}

	private renderTextSection(container: HTMLElement, title: string, value: string): void {
		if (!value) {
			return;
		}
		const section = container.createDiv({ cls: "weave-epub-book-info-section" });
		section.createDiv({ cls: "weave-epub-book-info-section-title", text: title });
		section.createDiv({ cls: "weave-epub-book-info-note is-body", text: value });
	}
}
