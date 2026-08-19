/**
 * Vault-scoped plugin local storage
 *
 * Plugin-owned local key/value state converges into the unified
 * weave-data.json document (schema v2 top-level `vaultLocalStorage`),
 * accessed through getSchemaV2Store. The public API is unchanged.
 */

import type { App } from "obsidian";
import {
	DEFAULT_DATA_PATH,
	normalizeDataPath,
} from "../config/paths";
import { CURRENT_PLUGIN_ID } from "../config/plugin-runtime";
import { getSchemaV2Store, type SchemaV2Store } from "../services/epub/schema-v2-store";
import { logger } from "./logger";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

class VaultLocalStorage {
	private app: App | null = null;
	private initializePromise: Promise<void> | null = null;
	private entries: Record<string, string> = {};

	setApp(app: App): void {
		this.app = app;
	}

	/** 生效的 weave-data.json 数据路径（读取插件设置 dataPath，回退默认）。 */
	private resolveDataPath(): string {
		const plugin = (this.app as unknown as {
			plugins?: {
				getPlugin?: (pluginId: string) => {
					settings?: { dataPath?: string };
				} | null | undefined;
			};
		})?.plugins?.getPlugin?.(CURRENT_PLUGIN_ID);
		return normalizeDataPath(plugin?.settings?.dataPath) || DEFAULT_DATA_PATH;
	}

	private getStore(): SchemaV2Store | null {
		if (!this.app) {
			return null;
		}
		return getSchemaV2Store(this.app, () => this.resolveDataPath());
	}

	async initialize(app: App): Promise<void> {
		if (this.app !== app || !this.initializePromise) {
			this.setApp(app);
			this.initializePromise = this.loadEntries();
		}
		await this.initializePromise;
	}

	getItem(key: string): string | null {
		if (typeof this.entries[key] === "string") {
			return this.entries[key];
		}
		return null;
	}

	setItem(key: string, value: string): void {
		this.entries[key] = value;
		const store = this.getStore();
		if (!store) {
			return;
		}
		store.mutate((document) => {
			document.vaultLocalStorage = { ...this.entries };
		});
	}

	removeItem(key: string): void {
		if (!(key in this.entries)) {
			return;
		}
		delete this.entries[key];
		const store = this.getStore();
		if (!store) {
			return;
		}
		store.mutate((document) => {
			document.vaultLocalStorage = { ...this.entries };
		});
	}

	/**
	 * Get all managed keys matching a prefix.
	 */
	getKeysWithPrefix(prefix: string): string[] {
		return Object.keys(this.entries).filter((key) => key.startsWith(prefix));
	}

	async flush(): Promise<void> {
		const store = this.getStore();
		if (store) {
			await store.flush();
		}
	}

	/**
	 * Test helper for resetting the singleton between runs.
	 */
	resetForTests(): void {
		this.app = null;
		this.entries = {};
		this.initializePromise = null;
	}

	private async loadEntries(): Promise<void> {
		const store = this.getStore();
		if (!store) {
			this.entries = {};
			return;
		}
		try {
			const document = await store.getDocument();
			const loaded: Record<string, string> = {};
			if (isRecord(document.vaultLocalStorage)) {
				for (const [key, value] of Object.entries(document.vaultLocalStorage)) {
					if (typeof value === "string") {
						loaded[key] = value;
					}
				}
			}
			this.entries = loaded;
		} catch (error) {
			logger.warn("[VaultLocalStorage] 读取 vaultLocalStorage 失败", error);
			this.entries = {};
		}
	}
}

export const vaultStorage = new VaultLocalStorage();
