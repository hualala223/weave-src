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
