import { App, PluginSettingTab } from "obsidian";
import { mount, unmount, type Component as SvelteComponent } from "svelte";
import type StandaloneEpubPlugin from "../../main";

export class EpubSettingsTab extends PluginSettingTab {
	plugin: StandaloneEpubPlugin;
	private svelteRoot: ReturnType<typeof mount> | null = null;

	constructor(app: App, plugin: StandaloneEpubPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Obsidian 1.13+ 声明式设置：`render` 类型回调的签名为 `(setting, group)`，
	 * 第一个参数是 `Setting` 实例（无 replaceChildren/empty，无法直接挂载 Svelte 面板）。
	 * 返回空数组回退到 `display()` 渲染路径（所有版本兼容）。
	 */
	getSettingDefinitions() {
		return [];
	}

	display(): void {
		void this.renderPanelInto(this.containerEl);
	}

	hide(): void {
		this.unmountPanel();
		this.containerEl.replaceChildren();
	}

	private unmountPanel(): void {
		if (!this.svelteRoot) {
			return;
		}
		void unmount(this.svelteRoot);
		this.svelteRoot = null;
	}

	private async renderPanelInto(containerEl: HTMLElement): Promise<void> {
		this.unmountPanel();

		containerEl.replaceChildren();

		const { default: Component } = await import("./EpubSettingsPanel.svelte");
		this.svelteRoot = mount(Component as SvelteComponent, {
			target: containerEl,
			props: {
				plugin: this.plugin,
			},
		});
	}
}
