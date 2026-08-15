import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../epub-runtime", () => ({
	getEpubRuntime: () => ({
		pluginId: "weave-epub-reader",
	}),
}));

import { registerEpubHost, resolveEpubHost, unregisterEpubHost } from "../epub-host";

describe("epub-host resolution", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("prefers the locally registered host capability when it exists", async () => {
		const runtimeHost = {
			openEpubReader: vi.fn(),
		};
		const getPlugin = vi.fn((pluginId: string) => {
			if (pluginId === "weave-epub-reader") {
				return runtimeHost;
			}
			return null;
		});
		const app = {
			plugins: {
				getPlugin,
			},
		} as any;
		const localHost = {
			openEpubReader: vi.fn(async () => undefined),
		};

		registerEpubHost(app, localHost);
		const resolved = resolveEpubHost(app);
		await resolved?.openEpubReader?.("Books/demo.epub");
		unregisterEpubHost(app);

		expect(localHost.openEpubReader).toHaveBeenCalledWith("Books/demo.epub");
		expect(runtimeHost.openEpubReader).not.toHaveBeenCalled();
	});

	it("does not expose local IR capabilities when the standalone host does not implement them", () => {
		const localHost = {
			openEpubReader: vi.fn(async () => undefined),
		};
		const app = {
			plugins: {
				getPlugin: vi.fn((pluginId: string) => {
					if (pluginId === "weave-epub-reader") {
						return localHost;
					}
					return null;
				}),
			},
		} as any;

		registerEpubHost(app, localHost);
		const resolved = resolveEpubHost(app);
		unregisterEpubHost(app);

		expect(resolved?.openIRReadingPointFromExternalSelection).toBeUndefined();
		expect(resolved?.scheduleEpubChapterForIncrementalReading).toBeUndefined();
		expect(resolved?.markEpubResumePointFromReader).toBeUndefined();
	});

	it("falls back to legacy Weave IR capabilities when the standalone host does not implement them", async () => {
		const legacyCreateReadingPoint = vi.fn(async () => undefined);
		const localHost = {
			openEpubReader: vi.fn(async () => undefined),
		};
		const app = {
			plugins: {
				getPlugin: vi.fn((pluginId: string) => {
					if (pluginId === "weave-epub-reader") {
						return localHost;
					}
					if (pluginId === "weave") {
						return {
							openIRReadingPointFromExternalSelection: legacyCreateReadingPoint,
						};
					}
					return null;
				}),
			},
		} as any;

		registerEpubHost(app, localHost);
		const resolved = resolveEpubHost(app);
		await resolved?.openIRReadingPointFromExternalSelection?.({
			filePath: "Books/demo.epub",
			selectedText: "demo excerpt",
		});
		unregisterEpubHost(app);

		expect(legacyCreateReadingPoint).toHaveBeenCalledWith({
			filePath: "Books/demo.epub",
			selectedText: "demo excerpt",
		});
	});

	it("falls back to the runtime plugin id when no local host is registered", () => {
		const runtimeHost = {
			openEpubReader: vi.fn(),
		};
		const getPlugin = vi.fn((pluginId: string) =>
			pluginId === "weave-epub-reader" ? runtimeHost : null
		);
		const app = {
			plugins: {
				getPlugin,
			},
		} as any;

		const resolved = resolveEpubHost(app);

		expect(getPlugin).toHaveBeenCalledWith("weave-epub-reader");
		expect(resolved).toBe(runtimeHost);
	});

	it("returns null when neither local host nor runtime plugin host is available", () => {
		const app = {
			plugins: {
				getPlugin: vi.fn(() => null),
			},
		} as any;

		expect(resolveEpubHost(app)).toBeNull();
	});
});
