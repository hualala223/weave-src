import { Setting } from "obsidian";
import {
	DEFAULT_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MAX_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
	MIN_CONTINUOUS_READING_POSITION_AUTO_SAVE_PAGES,
} from "../../config/reading-position-auto-save";
import { getEpubBacklinkHighlightService } from "../../services/epub/epub-backlink-highlight-access";
import { scheduleEpubAnnotationIndexWarmup } from "../../services/epub/epub-annotation-index";
import { showNotification } from "../../utils/notifications";
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

	const weaveParentFolderSetting = new Setting(hosts.reading)
		.setName('Weave 数据根目录（父目录）')
		.setDesc('书签、高亮、阅读状态等数据统一存放在 <父目录>/Weave/ 下。留空使用 vault 根目录下的 Weave/。修改后，未单独指定的目录会自动跟随此根目录。')
		.setClass("epub-weave-parent-folder-setting");

	mountFolderSearchSetting({
		setting: weaveParentFolderSetting,
		placeholder: '选择父目录（留空 = Vault 根下的 weave/）',
		value: snapshot.weaveParentFolderValue,
		onInput: callbacks.setWeaveParentFolderInput,
		onCommit: callbacks.updateWeaveParentFolder,
		onEscape: () => snapshot.weaveParentFolderValue,
		app: plugin.app,
		cleanupFns,
	});

	const bookmarkFolderSetting = new Setting(hosts.reading)
		.setName('书签目录')
		.setDesc('书签文件会保存到所选文件夹，属于基础免费能力。')
		.setClass("epub-bookmark-setting");

	mountFolderSearchSetting({
		setting: bookmarkFolderSetting,
		placeholder: '选择文件夹路径',
		value: snapshot.bookmarkFolderValue,
		onInput: callbacks.setBookmarkFolderInput,
		onCommit: callbacks.updateBookmarkFolder,
		onEscape: () => snapshot.bookmarkFolderValue,
		app: plugin.app,
		cleanupFns,
	});

	const highlightStoragePathSetting = new Setting(hosts.reading)
		.setName('高亮数据文件路径')
		.setDesc('本地高亮（划线标注）数据的存储位置，默认 Weave/local-storage.json。修改后旧数据会自动迁移到新路径。')
		.setClass("epub-highlight-storage-path-setting");

	highlightStoragePathSetting.addText((text) => {
		text.setPlaceholder('weave/local-storage.json');
		text.setValue(snapshot.highlightStoragePathInput);
		text.onChange((value) => {
			callbacks.setHighlightStoragePathInput(value);
		});

		const inputEl = text.inputEl;

		const commitValue = () => {
			void callbacks.updateHighlightStoragePath(inputEl.value);
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
				callbacks.setHighlightStoragePathInput(snapshot.highlightStoragePathValue);
				text.setValue(snapshot.highlightStoragePathValue);
				inputEl.blur();
			}
		};

		inputEl.addEventListener("blur", handleBlur);
		inputEl.addEventListener("keydown", handleKeydown);

		cleanupFns.push(() => inputEl.removeEventListener("blur", handleBlur));
		cleanupFns.push(() => inputEl.removeEventListener("keydown", handleKeydown));
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
		.setName('重建 EPUB 摘录索引')
		.setDesc('删除插件目录中的摘录缓存与来源索引后，在下次打开书籍时后台重建。不会删除笔记、canvas 或 .wdeck 中的卡片正文。')
		.setClass("epub-rebuild-highlight-index-setting")
		.addButton((button) => {
			button.setButtonText('重建索引');
			button.onClick(async () => {
				button.setDisabled(true);
				try {
					const service = getEpubBacklinkHighlightService(plugin.app);
					await service.rebuildHighlightIndexes();
					scheduleEpubAnnotationIndexWarmup(plugin.app, 2_000, { forceAll: true });
					showNotification('摘录索引缓存已清除，下次打开书籍时将重新建立。', "success");
				} catch (error) {
					console.error("[EpubSettings] rebuild highlight index failed:", error);
					showNotification('清除摘录索引缓存失败，请查看控制台日志。', "error");
				} finally {
					button.setDisabled(false);
				}
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
