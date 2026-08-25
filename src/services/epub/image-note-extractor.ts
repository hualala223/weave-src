/**
 * 图片提取输出管线（T02 / 服务核心）。
 *
 * 给定提取输入（书/章节/CFI/alt + 原图字节与 MIME），完成：
 * 1. 附件目录与文件名解析（`<附件根>/<净化书名>`，序号递增保证唯一——允许重复提取）；
 * 2. 二进制写入（依赖注入，由调用方提供 vault 写入实现）；
 * 3. 图片记录块构建（嵌入行 + 深链/章节/时间行，无 callout 包装）。
 *
 * 本模块不依赖 Obsidian 运行时，依赖全部注入（含附件根目录），便于单测。
 * 附件根目录由 config/paths 推导（默认 CONFIG/asset），不在本模块硬编码。
 */

import { EpubLinkService } from "./EpubLinkService";
import type { ReaderImageBytes } from "./reader-engine-types";

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^\[\]\u0000-\u001f{}]/g;
const MAX_BOOK_SEGMENT_LENGTH = 120;
const MAX_SEQUENCE_ATTEMPTS = 1000;

/** 规范化书目片段：移除文件名非法字符、折叠空白、去首尾点/空格、截断；空则回退 book。 */
export function sanitizeBookFileSegment(title: string): string {
	const cleaned = String(title || "")
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "")
		.slice(0, MAX_BOOK_SEGMENT_LENGTH);
	return cleaned || "book";
}

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/bmp": "bmp",
	"image/avif": "avif",
	"image/tiff": "tiff",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
};

/** 由 MIME 推断附件扩展名；未知 image/* 取子类型，其余回退 bin。 */
export function extensionForImageMimeType(mimeType: string): string {
	const normalized = String(mimeType || "")
		.trim()
		.toLowerCase();
	const explicit = IMAGE_EXTENSION_BY_MIME[normalized];
	if (explicit) {
		return explicit;
	}
	if (normalized.startsWith("image/")) {
		const subtype = normalized.slice("image/".length).replace(/\+/g, "_");
		return subtype || "bin";
	}
	return "bin";
}

/** 附件目录：<附件根>/<净化书名>（附件根由 config/paths 推导传入）。 */
export function buildImageAttachmentDir(
	bookTitle: string,
	attachmentRoot: string,
): string {
	return `${attachmentRoot}/${sanitizeBookFileSegment(bookTitle)}`;
}

/** 附件文件名：<净化书名>-<章节>-<两位序号>.<扩展名>。 */
export function buildImageAttachmentFileName(
	bookTitle: string,
	chapterIndex: number,
	sequence: number,
	extension: string,
): string {
	const safeChapterIndex = Number.isFinite(chapterIndex)
		? Math.max(0, Math.floor(chapterIndex))
		: 0;
	return `${sanitizeBookFileSegment(bookTitle)}-${safeChapterIndex}-${String(
		sequence,
	).padStart(2, "0")}.${extension}`;
}

/** 章节标签：净化+截断的章节标题，缺省回退「章节 N」。 */
function buildChapterLabel(
	chapterIndex: number,
	chapterTitle?: string,
	maxLength = EpubLinkService.MAX_CHAPTER_LABEL_LENGTH,
): string {
	const sanitized = String(chapterTitle || "")
		.replace(/\|/g, "\\|")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized) {
		return sanitized.length > maxLength
			? `${sanitized.slice(0, maxLength)}…`
			: sanitized;
	}
	return `章节 ${
		Number.isFinite(chapterIndex) ? Math.max(0, Math.floor(chapterIndex)) : 0
	}`;
}

/** 深链行后缀（与文字摘录块同构）：` [章节标签] 时间`。 */
export function buildImageNoteSuffix(
	chapterIndex: number,
	chapterTitle?: string,
	timestamp?: string,
	chapterLabelMaxLength = EpubLinkService.MAX_CHAPTER_LABEL_LENGTH,
): string {
	const parts: string[] = [
		`[${buildChapterLabel(chapterIndex, chapterTitle, chapterLabelMaxLength)}]`,
	];
	if (timestamp) {
		parts.push(timestamp);
	}
	return ` ${parts.join(" ")}`;
}

/** 图片记录块：嵌入行 + 深链/章节/时间行（无 callout 包装）。 */
export function buildImageNoteBlock(
	attachmentName: string,
	deepLinkLine: string,
	suffix: string,
	alt?: string,
): string {
	const altSuffix = alt
		? `|${String(alt).replace(/\|/g, "\\|").replace(/\n/g, " ")}`
		: "";
	return `![[${attachmentName}${altSuffix}]]\n${deepLinkLine}${suffix}`;
}

export interface ImageNoteInput {
	bookTitle: string;
	chapterIndex: number;
	chapterTitle?: string;
	/** 章节标签最大长度（遵循「完整路径」格式时为 96，否则 24）。 */
	chapterLabelMaxLength?: number;
	cfi: string;
	alt?: string;
	/** 'YYYY-MM-DD HH:mm'；仅当开启「添加创建时间」时传入。 */
	timestamp?: string;
}

export interface ImageNoteDeps {
	/** 附件根目录（vault 相对路径，由 config/paths 推导，默认 CONFIG/asset）。 */
	attachmentRoot: string;
	/** 确保附件目录存在（如 DirectoryUtils.ensureDirRecursive(vault.adapter, dir)）。 */
	ensureDir: (dir: string) => Promise<void>;
	/** 判断附件文件是否已存在（用于序号递增去重）。 */
	pathExists: (path: string) => Promise<boolean>;
	/** 写入附件字节（如 vault.adapter.writeBinary(path, bytes)）。 */
	writeBinary: (path: string, bytes: Uint8Array) => Promise<void>;
	/** 构建深链行（如 EpubLinkService.buildEpubLink(...) 的封装）。 */
	buildDeepLink: (input: {
		cfi: string;
		chapterIndex: number;
		chapterTitle?: string;
	}) => string;
}

export interface ImageNoteAttachmentResult {
	attachmentDir: string;
	attachmentName: string;
	attachmentPath: string;
	/** 插入笔记文档的完整块文本。 */
	block: string;
}

/** 提取主流程：解析命名 → 写附件 → 组块。 */
export async function extractImageToNote(
	input: ImageNoteInput,
	source: ReaderImageBytes,
	deps: ImageNoteDeps,
): Promise<ImageNoteAttachmentResult> {
	const extension = extensionForImageMimeType(source.mimeType);
	const attachmentDir = buildImageAttachmentDir(input.bookTitle, deps.attachmentRoot);
	await deps.ensureDir(attachmentDir);

	let sequence = 1;
	let attachmentName = "";
	let attachmentPath = "";
	for (; sequence < MAX_SEQUENCE_ATTEMPTS; sequence += 1) {
		attachmentName = buildImageAttachmentFileName(
			input.bookTitle,
			input.chapterIndex,
			sequence,
			extension,
		);
		attachmentPath = `${attachmentDir}/${attachmentName}`;
		if (!(await deps.pathExists(attachmentPath))) {
			break;
		}
	}
	if (sequence >= MAX_SEQUENCE_ATTEMPTS) {
		throw new Error("图片附件命名冲突过多，无法生成唯一文件名");
	}

	await deps.writeBinary(attachmentPath, source.bytes);
	const deepLinkLine = deps.buildDeepLink({
		cfi: input.cfi,
		chapterIndex: input.chapterIndex,
		chapterTitle: input.chapterTitle,
	});
	const suffix = buildImageNoteSuffix(
		input.chapterIndex,
		input.chapterTitle,
		input.timestamp,
		input.chapterLabelMaxLength,
	);
	return {
		attachmentDir,
		attachmentName,
		attachmentPath,
		block: buildImageNoteBlock(attachmentName, deepLinkLine, suffix, input.alt),
	};
}