import { describe, it, expect, vi } from "vitest";
import { requestUrl } from "obsidian";
import { resolveBzAIConfig, runBzAIChat, runBzAIChatStream, BZ_AI_DEFAULT_MODEL } from "./bz-ai";

function makeApp(settings?: unknown): any {
	const getPlugin = vi.fn((id: string) =>
		id === "bz" && settings !== undefined ? { settings } : null,
	);
	return { plugins: { getPlugin } };
}

describe("resolveBzAIConfig", () => {
	it("缺 bz 插件时返回带指引的错误", () => {
		const result = resolveBzAIConfig(makeApp(undefined));
		expect(result.provider).toBeNull();
		expect(result.error).toContain("包仔");
	});

	it("默认 opencode-go 未配置 key 时报错", () => {
		const result = resolveBzAIConfig(makeApp({}));
		expect(result.provider).toBeNull();
		expect(result.error).toContain("OpenCode Go");
	});

	it("opencode-go 配好 key 时解析端点与默认模型", () => {
		const result = resolveBzAIConfig(
			makeApp({
				aiProvider: "opencode-go",
				opencodeGoApiKey: "ok",
			}),
		);
		expect(result.provider).toMatchObject({
			endpoint: "https://opencode.ai/zen/go/v1",
			apiKey: "ok",
			model: BZ_AI_DEFAULT_MODEL,
		});
	});

	it("deepseek 使用配置的 key 与端点", () => {
		const result = resolveBzAIConfig(
			makeApp({
				aiProvider: "deepseek",
				deepseekApiKey: "dk",
			}),
		);
		expect(result.provider).toMatchObject({
			endpoint: "https://api.deepseek.com",
			apiKey: "dk",
		});
	});

	it("deepseek 无 key 时返回错误", () => {
		const result = resolveBzAIConfig(makeApp({ aiProvider: "deepseek" }));
		expect(result.provider).toBeNull();
		expect(result.error).toContain("DeepSeek");
	});
});

describe("runBzAIChat", () => {
	it("未配置时直接抛错，不发起请求", async () => {
		const app = makeApp({});
		await expect(
			runBzAIChat(app, [{ role: "user", content: "hi" }]),
		).rejects.toThrow();
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("正常返回时去掉首尾空白", async () => {
		const app = makeApp({ aiProvider: "deepseek", deepseekApiKey: "dk" });
		vi.mocked(requestUrl).mockResolvedValueOnce({
			text: JSON.stringify({
				choices: [{ message: { content: "  释义内容  " } }],
			}),
		} as any);
		const result = await runBzAIChat(app, [
			{ role: "user", content: "serendipity" },
		]);
		expect(result).toBe("释义内容");
		const call = vi.mocked(requestUrl).mock.calls[0][0] as any;
		expect(call.url).toBe("https://api.deepseek.com/chat/completions");
		expect(call.body).toContain('"stream":false');
	});

	it("API 错误对象被提取为消息", async () => {
		const app = makeApp({ aiProvider: "deepseek", deepseekApiKey: "dk" });
		vi.mocked(requestUrl).mockResolvedValueOnce({
			text: JSON.stringify({ choices: [], error: { message: "余额不足" } }),
		} as any);
		await expect(
			runBzAIChat(app, [{ role: "user", content: "x" }]),
		).rejects.toThrow("余额不足");
	});
});

describe("runBzAIChatStream", () => {
	it("opencode-go（无 CORS）回退 requestUrl 一次性回调", async () => {
		const app = makeApp({ aiProvider: "opencode-go", opencodeGoApiKey: "ok" });
		vi.mocked(requestUrl).mockResolvedValueOnce({
			text: JSON.stringify({ choices: [{ message: { content: " 释义内容 " } }] }),
		} as any);

		const deltas: string[] = [];
		const result = await runBzAIChatStream(
			app,
			[{ role: "user", content: "word" }],
			{ onDelta: (d) => deltas.push(d) },
		);

		expect(result).toBe("释义内容");
		expect(deltas).toEqual(["释义内容"]);
		const call = vi.mocked(requestUrl).mock.calls[0][0] as any;
		expect(call.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
		expect(call.body).toContain('"stream":false');
	});

	it("deepseek 走 fetch SSE 逐字回调", async () => {
		const app = makeApp({ aiProvider: "deepseek", deepseekApiKey: "dk" });
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
							'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
							"data: [DONE]\n\n",
					),
				);
				controller.close();
			},
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, body } as Response);
		vi.stubGlobal("fetch", fetchMock);

		const deltas: string[] = [];
		try {
			const result = await runBzAIChatStream(
				app,
				[{ role: "user", content: "hi" }],
				{ onDelta: (d) => deltas.push(d) },
			);
			expect(result).toBe("你好");
			expect(deltas).toEqual(["你", "好"]);
			const init = fetchMock.mock.calls[0][1] as { body?: string };
			expect(init?.body).toContain('"stream":true');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("未配置时直接抛错且不调 requestUrl", async () => {
		const app = makeApp({});
		await expect(
			runBzAIChatStream(app, [{ role: "user", content: "x" }]),
		).rejects.toThrow();
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
