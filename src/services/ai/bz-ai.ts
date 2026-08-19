import { requestUrl } from "obsidian";
import type { App } from "obsidian";

/**
 * bz（包仔）AI 客户端 —— Weave 不自持 AI 配置，直接复用 bz 插件的设置。
 *
 * 解析规则与 bz `src/core/ai.ts` 的 getAIProvider 保持一致：
 * - provider = opencode-go（默认）→ 端点 https://opencode.ai/zen/go/v1，无 CORS → requestUrl；
 * - provider = deepseek → 端点 https://api.deepseek.com，可 fetch 流式；
 * - 缺 key 抛出带指引的错误信息，由 UI 提示用户去 bz 设置里配置。
 */

const BZ_PLUGIN_ID = "bz";

export const BZ_AI_DEFAULT_MODEL = "deepseek-v4-flash";

export interface BzAIProvider {
	endpoint: string;
	apiKey: string;
	model: string;
	/** 无 CORS 头：fetch 流式必败，只能走 requestUrl 一次性返回。 */
	noCors: boolean;
}

export interface BzAIConfigResult {
	provider: BzAIProvider | null;
	error?: string;
}

type BzAISettingsLike = Partial<{
	aiProvider: string;
	deepseekApiKey: string;
	opencodeGoApiKey: string;
}>;

export function resolveBzAIConfig(app: unknown): BzAIConfigResult {
	const host = app as
		| { plugins?: { getPlugin?: (id: string) => unknown } }
		| null
		| undefined;
	const plugin = host?.plugins?.getPlugin?.(BZ_PLUGIN_ID) as
		| { settings?: BzAISettingsLike }
		| null
		| undefined;
	if (!plugin?.settings) {
		return {
			provider: null,
			error:
				"未找到「包仔」插件——AI 功能依赖它。请先安装并启用「包仔」，再到它的设置里配置 AI。",
		};
	}
	const settings = plugin.settings;
	const providerName =
		typeof settings.aiProvider === "string" && settings.aiProvider
			? settings.aiProvider
			: "opencode-go";

	if (providerName === "opencode-go") {
		if (!settings.opencodeGoApiKey) {
			return {
				provider: null,
				error: "未配置 OpenCode Go API Key：请到「包仔」设置 → AI 配置 填写。",
			};
		}
		return {
			provider: {
				endpoint: "https://opencode.ai/zen/go/v1",
				apiKey: settings.opencodeGoApiKey,
				model: BZ_AI_DEFAULT_MODEL,
				noCors: true,
			},
		};
	}

	if (settings.deepseekApiKey) {
		return {
			provider: {
				endpoint: "https://api.deepseek.com",
				apiKey: settings.deepseekApiKey,
				model: BZ_AI_DEFAULT_MODEL,
				noCors: false,
			},
		};
	}

	return {
		provider: null,
		error:
			"未找到 AI 配置：请到「包仔」设置 → AI 配置 填写 DeepSeek 或 OpenCode Go 的 API Key。",
	};
}

export interface BzAIChatMessage {
	role: "user" | "system";
	content: string;
}

export interface BzAIChatOptions {
	model?: string;
	maxTokens?: number;
	temperature?: number;
}

export interface BzAIChatStreamHandlers {
	/** 每次收到增量时回调（流式逐字 / 非流式一次性）。 */
	onDelta?: (delta: string) => void;
}

function buildChatCompletionBody(
	provider: BzAIProvider,
	messages: BzAIChatMessage[],
	stream: boolean,
	options: BzAIChatOptions,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: options.model || provider.model || BZ_AI_DEFAULT_MODEL,
		messages,
		stream,
	};
	if (typeof options.maxTokens === "number") {
		body.max_tokens = options.maxTokens;
	}
	if (typeof options.temperature === "number") {
		body.temperature = options.temperature;
	}
	return body;
}

function readChatCompletionResponse(text: string): {
	content?: string;
	errorMessage?: string;
} {
	let data: unknown = {};
	try {
		data = JSON.parse(text);
	} catch (_e) {
		return { errorMessage: "AI 返回无法解析" };
	}
	const record = data as {
		choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
		error?: unknown;
	};
	const content =
		record?.choices?.[0]?.message?.content ?? record?.choices?.[0]?.text;
	if (typeof content === "string" && content.trim()) {
		return { content: content.trim() };
	}
	return { errorMessage: extractAIChatErrorMessage(record.error) || "AI 返回为空" };
}

/** 非流式请求（Obsidian requestUrl，无 CORS 限制）。 */
async function requestNonStreamChat(
	provider: BzAIProvider,
	body: Record<string, unknown>,
): Promise<string> {
	const response = await requestUrl({
		url: `${provider.endpoint}/chat/completions`,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${provider.apiKey}`,
		},
		body: JSON.stringify(body),
	});
	const parsed = readChatCompletionResponse(response.text);
	if (!parsed.content) {
		throw new Error(parsed.errorMessage || "AI 返回为空");
	}
	return parsed.content;
}

/** fetch SSE 流式（仅对带 CORS 的 provider 有效）。 */
async function streamChatViaFetch(
	provider: BzAIProvider,
	body: Record<string, unknown>,
	handlers: BzAIChatStreamHandlers,
): Promise<string> {
	const response = await fetch(`${provider.endpoint}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${provider.apiKey}`,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(await readFetchErrorMessage(response));
	}
	if (
		!response.body ||
		typeof (response.body as unknown as { getReader?: unknown }).getReader !==
			"function"
	) {
		const parsed = readChatCompletionResponse(await response.text());
		if (!parsed.content) {
			throw new Error(parsed.errorMessage || "AI 返回为空");
		}
		handlers.onDelta?.(parsed.content);
		return parsed.content;
	}

	const reader = (
		response.body as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }
	).getReader();
	const decoder = new TextDecoder();
	let full = "";
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line.startsWith("data:")) {
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") {
					try {
						void reader.cancel();
					} catch {
						/* 忽略 */
					}
					return full;
				}
				try {
					const chunk = JSON.parse(payload) as {
						choices?: Array<{ delta?: { content?: unknown } }>;
					};
					const delta = chunk?.choices?.[0]?.delta?.content;
					if (typeof delta === "string" && delta) {
						full += delta;
						handlers.onDelta?.(delta);
					}
				} catch {
					/* 忽略坏 chunk */
				}
			}
			nl = buffer.indexOf("\n");
		}
	}
	return full;
}

async function readFetchErrorMessage(response: Response): Promise<string> {
	let message = `API ${response.status}`;
	try {
		const parsed = readChatCompletionResponse(await response.text());
		message = parsed.errorMessage || message;
	} catch {
		/* 保留状态码 */
	}
	return message;
}

/** 单轮非流式 chat completion（requestUrl；opencode-go/deepseek 均可用）。 */
export async function runBzAIChat(
	app: App,
	messages: BzAIChatMessage[],
	options: BzAIChatOptions = {},
): Promise<string> {
	const { provider, error } = resolveBzAIConfig(app);
	if (!provider) {
		throw new Error(error || "AI 未配置");
	}
	return requestNonStreamChat(
		provider,
		buildChatCompletionBody(provider, messages, false, options),
	);
}

/**
 * 流式 chat completion：
 * - deepseek（有 CORS）：fetch SSE，逐字回调 onDelta；
 * - opencode-go（无 CORS）：fetch 必败，回退 requestUrl 一次性返回后单次回调 onDelta。
 */
export async function runBzAIChatStream(
	app: unknown,
	messages: BzAIChatMessage[],
	handlers: BzAIChatStreamHandlers = {},
	options: BzAIChatOptions = {},
): Promise<string> {
	const { provider, error } = resolveBzAIConfig(app);
	if (!provider) {
		throw new Error(error || "AI 未配置");
	}
	const body = buildChatCompletionBody(provider, messages, true, options);

	if (provider.noCors) {
		const content = await requestNonStreamChat(provider, {
			...body,
			stream: false,
		});
		handlers.onDelta?.(content);
		return content;
	}

	return streamChatViaFetch(provider, body, handlers);
}

function extractAIChatErrorMessage(error: unknown): string {
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object") {
		const record = error as { message?: unknown; error?: unknown };
		if (typeof record.message === "string") {
			return record.message;
		}
		if (record.error && typeof record.error === "object") {
			const nested = record.error as { message?: unknown };
			if (typeof nested.message === "string") {
				return nested.message;
			}
		}
	}
	return "";
}
