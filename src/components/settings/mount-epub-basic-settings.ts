import { Setting } from "obsidian";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
} from "../../config/reading-position-auto-save";
import { mountFolderSearchSetting } from "./epub-settings-folder-search";
import type {
	EpubBasicSettingsMountOptions,
	SettingsCleanupFn,
} from "./epub-settings-types";

function clearHosts(hosts: EpubBasicSettingsMountOptions["hosts"]): void {
	hosts.interface.replaceChildren();
	hosts.reading.replaceChildren();
	hosts.diagnostics.replaceChildren();
}

export function mountEpubBasicSettings(options: EpubBasicSettingsMountOptions): SettingsCleanupFn {
	const { plugin, hosts, snapshot, callbacks } = options;
	const cleanupFns: SettingsCleanupFn[] = [];

	callbacks.setAutoSavePagesTextControl(null);
	clearHosts(hosts);

	const dataPathSetting = new Setting(hosts.reading)
		.setName('数据路径')
		.setDesc('书签、高亮、阅读进度、书架与溯源等全部阅读数据统一保存在该目录下的 weave-data.json 中（缓存与备份位于其 cache/ 与 backups/ 子目录）。默认 CONFIG/STORAGE。')
		.setClass("epub-data-path-setting");

	mountFolderSearchSetting({
		setting: dataPathSetting,
		placeholder: 'CONFIG/STORAGE',
		value: snapshot.dataPathValue,
		onInput: callbacks.setDataPathInput,
		onCommit: callbacks.updateDataPath,
		onEscape: () => snapshot.dataPathValue,
		app: plugin.app,
		cleanupFns,
	});

	const autoSaveSetting = new Setting(hosts.reading)
		.setName('自动记录阅读位置')
		.setDesc('连续阅读达到设定页数后自动保存当前位置；关闭阅读器或切换书籍时仍会保存最后位置。')
		.setClass("epub-reading-position-auto-save-toggle-setting");

	autoSaveSetting.addToggle((toggle) => {
		toggle.setValue(snapshot.continuousReadingPositionAutoSaveEnabled);
		toggle.onChange(async (value) => {
			await callbacks.updateContinuousReadingPositionAutoSaveEnabled(value);
		});
	});

	const autoSavePagesSetting = new Setting(hosts.reading)
		.setName('连续阅读页数')
		.setDesc(
			`达到该页数时自动记录一次阅读位置。范围 ${MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES}-${MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES} 页，默认 ${DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES} 页。`
		)
		.setClass("epub-reading-position-auto-save-pages-setting");

	autoSavePagesSetting.addText((text) => {
		callbacks.setAutoSavePagesTextControl(text);
		text.inputEl.type = "number";
		text.inputEl.min = String(MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES);
		text.inputEl.max = String(MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES);
		text.setPlaceholder(String(DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES));
		text.setValue(snapshot.continuousReadingPositionAutoSavePagesInput);
		text.setDisabled(!snapshot.continuousReadingPositionAutoSaveEnabled);
		text.onChange((value) => {
			callbacks.setContinuousReadingPositionAutoSavePagesInput(value);
		});

		const inputEl = text.inputEl;

		const commitValue = () => {
			if (!snapshot.continuousReadingPositionAutoSaveEnabled) {
				callbacks.setContinuousReadingPositionAutoSavePagesInput(
					String(snapshot.continuousReadingPositionAutoSavePages)
				);
				text.setValue(String(snapshot.continuousReadingPositionAutoSavePages));
				return;
			}
			void callbacks.updateContinuousReadingPositionAutoSavePages(inputEl.value);
		};

		const handleBlur = () => {
			commitValue();
		};

		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitValue();
				return;
			}

			if (event.key === "Escape") {
				callbacks.setContinuousReadingPositionAutoSavePagesInput(
					String(snapshot.continuousReadingPositionAutoSavePages)
				);
				text.setValue(String(snapshot.continuousReadingPositionAutoSavePages));
				inputEl.blur();
			}
		};

		inputEl.addEventListener("blur", handleBlur);
		inputEl.addEventListener("keydown", handleKeydown);

		cleanupFns.push(() => inputEl.removeEventListener("blur", handleBlur));
		cleanupFns.push(() => inputEl.removeEventListener("keydown", handleKeydown));
	});

	new Setting(hosts.reading)
		.setName('全局翻页按钮样式')
		.setDesc('开启后，上一页按钮放大为屏幕左侧 10% 宽、下一页为右侧 90% 宽，高度 10vh；按钮隐藏但可点击，底部状态栏隐藏，翻页无滑动动画。默认关闭。')
		.setClass("epub-large-nav-buttons-toggle-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.largeNavButtonsEnabled);
			toggle.onChange(async (value) => {
				await callbacks.updateLargeNavButtons(value);
			});
		});

	new Setting(hosts.diagnostics)
		.setName('摘录段落悬停预览')
		.setDesc('在笔记文档中鼠标悬停摘录块时，浮框预览该摘录在书中的完整段落（划线部分按摘录颜色高亮）；按住 Ctrl 悬停可立即显示。默认开启。')
		.setClass("epub-excerpt-hover-preview-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.excerptParagraphHoverPreviewEnabled);
			toggle.onChange(async (value) => {
				await callbacks.updateExcerptParagraphHoverPreview(value);
			});
		});

	new Setting(hosts.diagnostics)
		.setName('溯源跳转时在新标签页打开笔记')
		.setDesc('从阅读器跳转到 Markdown、canvas 或 json 来源时，优先复用已打开的标签页；关闭后会在新标签页打开，便于与当前书籍并排阅读。')
		.setClass("epub-source-navigation-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.sourceNavigationOpenInNewTab);
			toggle.onChange(async (value) => {
				await callbacks.updateSourceNavigationOpenInNewTab(value);
			});
		});

	new Setting(hosts.diagnostics)
		.setName('调试模式')
		.setDesc('开启后会输出更完整的调试日志，便于排查脚注预览、阅读器渲染与热重载问题。')
		.setClass("epub-debug-setting")
		.addToggle((toggle) => {
			toggle.setValue(snapshot.debugModeEnabled);
			toggle.onChange(async (value) => {
				await callbacks.updateDebugMode(value);
			});
		});

	return () => {
		cleanupFns.forEach((cleanup) => cleanup());
		callbacks.setAutoSavePagesTextControl(null);
		clearHosts(hosts);
	};
}
