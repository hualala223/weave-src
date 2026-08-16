import type {
	EpubWeaveOfficialAPI,
	EpubWeaveOfficialAPIInfo,
} from "./epub-host";

/**
 * EPUB 摘录官方 API。
 * 反链高亮（backlink highlight）来源已移除，摘录删除（removeExcerpt）能力随之停用；
 * 本服务仅提供官方 API 信息，供宿主注册/解析使用。
 */
export class EpubExcerptOfficialApiService implements EpubWeaveOfficialAPI {
	getInfo(): EpubWeaveOfficialAPIInfo {
		return {
			apiName: "weave-epub-excerpts",
			apiVersion: "0.1.0",
			stage: "experimental",
			capabilities: {
				excerpts: {
					remove: false,
					supportsSidLocator: true,
					supportsExcerptId: true,
					supportsInteractiveUserChoice: true,
				},
			},
		};
	}
}
