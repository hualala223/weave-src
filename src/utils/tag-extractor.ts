	const TAG_BODY_PATTERN = String.raw`[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*`;
const EXTRACT_TAG_REGEX = new RegExp(`#(${TAG_BODY_PATTERN})`, "gu");
const FRONTMATTER_REGEX = /^---[\t ]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;
const WIKILINK_REGEX = /\[\[[^\]]*\]\]/g;
const MARKDOWN_LINK_URL_REGEX = /\]\([^)]*\)/g;
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/g;

/** 提取和整理 Markdown 中的内联标签。 */

export class TagExtractor {
	/** 规范化内容，移除不应参与 `#标签` 识别的结构噪音。 */
	private static sanitizeContentForTagExtraction(content: string): string {
		let cleanedContent = content.replace(FRONTMATTER_REGEX, "");
		cleanedContent = cleanedContent.replace(FENCED_CODE_BLOCK_REGEX, "");
		cleanedContent = cleanedContent.replace(INLINE_CODE_REGEX, "");
		cleanedContent = cleanedContent.replace(WIKILINK_REGEX, "");
		cleanedContent = cleanedContent.replace(MARKDOWN_LINK_URL_REGEX, "](removed)");
		cleanedContent = cleanedContent.replace(HTML_COMMENT_REGEX, "");
		cleanedContent = cleanedContent.replace(HTML_TAG_REGEX, "");
		return cleanedContent;
	}

	/** 提取内容中的所有内联标签，不含 `#` 前缀。 */
	static extractTags(content: string): string[] {
		if (!content || typeof content !== "string") {
			return [];
		}

		const matches = content.matchAll(EXTRACT_TAG_REGEX);
		const tags = new Set<string>();

		for (const match of matches) {
			const tag = match[1].trim();
			if (tag && !/^\p{N}+$/u.test(tag)) {
				tags.add(tag);
			}
		}

		return Array.from(tags).sort();
	}

	/** 提取标签，并跳过代码块、行内代码和链接目标中的 `#`。 */
	static extractTagsExcludingCode(content: string): string[] {
		if (!content || typeof content !== "string") {
			return [];
		}

		return this.extractTags(this.sanitizeContentForTagExtraction(content));
	}
}
