import { generateCardUUID } from "../identifier/WeaveIDGenerator";
import { EpubLinkService } from "./EpubLinkService";
import type { EpubStorageService } from "./EpubStorageService";
import type { ConcealedText } from "./types";

/**
 * EPUB 注解服务。
 * 反链高亮（backlink highlight）来源已移除，本服务只保留"隐藏文本"（concealed text）能力，
 * 由 EPUB 存储层持久化。
 */
export class EpubAnnotationService {
	private storageService: EpubStorageService;

	constructor(storageService: EpubStorageService) {
		this.storageService = storageService;
	}

	async createConcealedText(
		bookId: string,
		text: string,
		chapterIndex: number,
		cfiRange: string,
		mode: ConcealedText["mode"] = "mask",
	): Promise<ConcealedText> {
		const concealedText: ConcealedText = {
			id: generateCardUUID(),
			text,
			mode,
			chapterIndex,
			cfiRange,
			createdTime: Date.now(),
		};

		await this.storageService.addConcealedText(bookId, concealedText);
		return concealedText;
	}

	async deleteConcealedTextByCfi(
		bookId: string,
		cfiRange: string,
	): Promise<void> {
		const normalizedTarget = EpubLinkService.normalizeCfi(cfiRange);
		const concealedTexts = await this.storageService.loadConcealedTexts(bookId);
		const filtered = concealedTexts.filter(
			(item) =>
				EpubLinkService.normalizeCfi(item.cfiRange) !== normalizedTarget,
		);
		await this.storageService.saveConcealedTexts(bookId, filtered);
	}

	async getConcealedTexts(bookId: string): Promise<ConcealedText[]> {
		return await this.storageService.loadConcealedTexts(bookId);
	}
}
