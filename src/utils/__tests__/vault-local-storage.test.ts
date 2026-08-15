import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "obsidian";
import { vaultStorage } from "../vault-local-storage";
import { getWeaveDataStore } from "../../services/epub/weave-data-store";

function createMemoryAdapter(initialFiles: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const writes: string[] = [];

	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		read: vi.fn(async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`File not found: ${path}`);
			return value;
		}),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
			writes.push(path);
		}),
		rename: vi.fn(async (oldPath: string, newPath: string) => {
			if (!files.has(oldPath)) throw new Error(`Missing temp: ${oldPath}`);
			files.set(newPath, files.get(oldPath) as string);
			files.delete(oldPath);
		}),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
		mkdir: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
	};

	return { adapter, files, writes };
}

function createApp(initialFiles: Record<string, string> = {}) {
	const { adapter, files, writes } = createMemoryAdapter(initialFiles);
	const app = new App();
	(app as any).vault = { adapter };
	(app as any).plugins = {
		getPlugin: vi.fn(() => ({
			settings: { dataPath: "CONFIG/STORAGE" },
		})),
	};
	return { app, files, writes };
}

const WEAVE_DATA_FILE = "CONFIG/STORAGE/weave-data.json";

describe("vault-local-storage", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vaultStorage.resetForTests();
		vi.useRealTimers();
	});

	it("persists setItem into the highlights section of weave-data.json", async () => {
		const { app, files } = createApp();
		await vaultStorage.initialize(app as any);

		vaultStorage.setItem("weave-inline-hl-book-1", JSON.stringify([{ cfi: "/6/2" }]));
		vaultStorage.setItem("weave-search-history-demo", "query");

		await vaultStorage.flush();

		const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) as string);
		expect(parsed.highlights).toEqual({
			"weave-inline-hl-book-1": JSON.stringify([{ cfi: "/6/2" }]),
			"weave-search-history-demo": "query",
		});
	});

	it("reads back persisted keys into the highlights section after init", async () => {
		const { app, files } = createApp({
			[WEAVE_DATA_FILE]: JSON.stringify({
				schemaVersion: 1,
				highlights: { "weave-inline-hl-a": "[1]" },
			}),
		});
		await vaultStorage.initialize(app as any);

		expect(vaultStorage.getItem("weave-inline-hl-a")).toBe("[1]");
		expect(vaultStorage.getItem("missing")).toBeNull();
		expect(vaultStorage.getKeysWithPrefix("weave-inline-hl-")).toEqual([
			"weave-inline-hl-a",
		]);
	});

	it("removeItem deletes the key from the highlights section", async () => {
		const { app, files } = createApp({
			[WEAVE_DATA_FILE]: JSON.stringify({
				schemaVersion: 1,
				highlights: { "weave-inline-hl-a": "[1]", "weave-key-b": "v" },
			}),
		});
		await vaultStorage.initialize(app as any);

		vaultStorage.removeItem("weave-inline-hl-a");
		expect(vaultStorage.getItem("weave-inline-hl-a")).toBeNull();

		await vaultStorage.flush();
		const parsed = JSON.parse(files.get(WEAVE_DATA_FILE) as string);
		expect(parsed.highlights).toEqual({ "weave-key-b": "v" });
	});

	it("reads back a fresh store from the persisted highlights section", async () => {
		const { app } = createApp();
		await vaultStorage.initialize(app as any);
		vaultStorage.setItem("weave-inline-hl-book-x", JSON.stringify([{ cfi: "/4" }]));
		await vaultStorage.flush();

		vaultStorage.resetForTests();
		await vaultStorage.initialize(app as any);
		expect(vaultStorage.getItem("weave-inline-hl-book-x")).toBe(
			JSON.stringify([{ cfi: "/4" }])
		);

		// The shared store singleton carries the same highlights document.
		const store = getWeaveDataStore(app as any, () => "CONFIG/STORAGE");
		const doc = await store.getDocument();
		expect(doc.highlights).toEqual({
			"weave-inline-hl-book-x": JSON.stringify([{ cfi: "/4" }]),
		});
	});
});