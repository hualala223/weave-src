import type { App } from "obsidian";

export type EpubViewHost = {
	app: App;
	openEpubReader?: (filePath: string) => Promise<void>;
	/**
	 * 阅读页头部动作栏与内联工具栏是否显示「自动化」（zap 闪电）按钮。
	 * 缺省视为不显示（该按钮默认不上阅读页，见设置 showAutoInsertButtonOnReader）。
	 */
	isAutoInsertButtonOnReaderVisible?: () => boolean;
};
