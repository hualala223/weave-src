/**
 * 临时性能探针（诊断专用，确认瓶颈后整体删除本文件与全部调用点）。
 *
 * 背景：用户反馈「划线要点很久才画上去、复制粘贴也一样慢」。静态定位指向
 * 标注全量同步中的 `resolveHighlightSectionIndexForView` → `findRangeByTextQuote`
 * 链路（对全书每条划线做整章全文扫描），但需要实测确认。
 *
 * 本模块**只做计时与计数，不改变任何控制流与返回值**。
 *
 * 用法：控制台执行 `__weavePerf.report()` 打印汇总，`__weavePerf.reset()` 清零。
 */

// 第二轮排查（用户报「用着用着又慢起来」）。开着，但一旦挂上文件 sink
// 就不再往控制台打，避免 console 本身成为观测噪声。
const PROBE_ENABLED = true;

/** 单次耗时超过该阈值才即时打印，避免刷屏。 */
const LOG_THRESHOLD_MS = 3;

/**
 * 文件 sink：挂上后，`always: true` 的采样行改为写入该回调（由宿主落盘），
 * 控制台不再输出——这样用户不用开 DevTools，也不引入 console 开销。
 */
type PerfSink = (line: string) => void;
let sink: PerfSink | null = null;

export function perfSetSink(next: PerfSink | null): void {
	sink = next;
}

/** 是否已挂文件 sink（挂上后走文件、不吵控制台）。 */
export function perfHasSink(): boolean {
	return sink !== null;
}

function emitLine(label: string, ms: number | null, extra?: Record<string, unknown>): void {
	if (!sink) {
		return;
	}
	const time = new Date().toISOString().slice(11, 23);
	const payload = extra && Object.keys(extra).length ? JSON.stringify(extra) : "";
	sink([time, label, ms === null ? "" : ms.toFixed(1), payload].join("\t"));
}

/**
 * 统一走 console.info：Chrome/Electron 的控制台默认过滤掉 Verbose 级别，
 * 而 console.debug 属于 Verbose —— 用它会「跑了但什么都看不见」。
 * 挂了文件 sink 时静默，只落盘。
 */
function probeLog(message: string, ...args: unknown[]): void {
	if (!sink) {
		console.info(message, ...args);
	}
}

/** 只记录一个「瞬时值」（如缓存条目数），不参与耗时统计。 */
export function perfGauge(label: string, extra?: Record<string, unknown>): void {
	if (!PROBE_ENABLED) {
		return;
	}
	emitLine(label, null, extra);
}

interface PerfSample {
	count: number;
	totalMs: number;
	maxMs: number;
}

const samples = new Map<string, PerfSample>();

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function record(label: string, ms: number): void {
	const existing = samples.get(label);
	if (!existing) {
		samples.set(label, { count: 1, totalMs: ms, maxMs: ms });
		return;
	}
	existing.count += 1;
	existing.totalMs += ms;
	if (ms > existing.maxMs) {
		existing.maxMs = ms;
	}
}

export function perfEnabled(): boolean {
	return PROBE_ENABLED;
}

/** 取开始时刻；探针关闭时返回 0。 */
export function perfBegin(): number {
	return PROBE_ENABLED ? nowMs() : 0;
}

/** 结束计时。返回耗时（ms）；探针关闭时返回 0。 */
export function perfEnd(
	label: string,
	startedAt: number,
	options?: { always?: boolean; extra?: Record<string, unknown> }
): number {
	if (!PROBE_ENABLED) {
		return 0;
	}
	const ms = nowMs() - startedAt;
	record(label, ms);
	if (options?.always) {
		// 关键路径：落盘（或退化为控制台），用于事后分析趋势。
		emitLine(label, ms, options.extra);
	}
	if (options?.always || ms >= LOG_THRESHOLD_MS) {
		probeLog(`[weave-perf] ${label} ${ms.toFixed(1)}ms`, options?.extra ?? "");
	}
	return ms;
}

/** 只计数不计时（用于统计某条路径被走了多少次）。 */
export function perfTick(label: string, n = 1): void {
	if (!PROBE_ENABLED) {
		return;
	}
	const existing = samples.get(label);
	if (!existing) {
		samples.set(label, { count: n, totalMs: 0, maxMs: 0 });
		return;
	}
	existing.count += n;
}

export async function perfSpanAsync<T>(
	label: string,
	fn: () => Promise<T>,
	extra?: Record<string, unknown>
): Promise<T> {
	if (!PROBE_ENABLED) {
		return fn();
	}
	const startedAt = nowMs();
	try {
		return await fn();
	} finally {
		perfEnd(label, startedAt, { always: true, extra });
	}
}

export function perfSpan<T>(
	label: string,
	fn: () => T,
	extra?: Record<string, unknown>
): T {
	if (!PROBE_ENABLED) {
		return fn();
	}
	const startedAt = nowMs();
	try {
		return fn();
	} finally {
		perfEnd(label, startedAt, { always: true, extra });
	}
}

interface PerfRow {
	label: string;
	count: number;
	totalMs: number;
	avgMs: number;
	maxMs: number;
}

function buildRows(): PerfRow[] {
	return Array.from(samples.entries())
		.map(([label, sample]) => ({
			label,
			count: sample.count,
			totalMs: Number(sample.totalMs.toFixed(1)),
			avgMs: Number((sample.totalMs / sample.count).toFixed(2)),
			maxMs: Number(sample.maxMs.toFixed(1)),
		}))
		.sort((left, right) => right.totalMs - left.totalMs);
}

/** 汇总的可复制文本（TSV，便于直接粘贴到对话里）。 */
export function perfText(): string {
	const rows = buildRows();
	if (rows.length === 0) {
		return "[weave-perf] 无采样数据（探针未触发或已被 reset）";
	}
	const header = ["label", "count", "totalMs", "avgMs", "maxMs"].join("\t");
	const body = rows.map((row) =>
		[row.label, row.count, row.totalMs, row.avgMs, row.maxMs].join("\t")
	);
	return [header, ...body].join("\n");
}

/** 打印汇总（按总耗时降序）。 */
export function perfReport(): void {
	if (!PROBE_ENABLED) {
		return;
	}
	const rows = buildRows();
	console.table(rows);
	probeLog(`[weave-perf] summary\n${perfText()}`);
}

/** 把汇总直接写进剪贴板，省去在控制台里框选。 */
export async function perfCopy(): Promise<void> {
	const text = perfText();
	try {
		await navigator.clipboard.writeText(text);
		probeLog("[weave-perf] 汇总已复制到剪贴板，直接 Ctrl+V 即可");
	} catch (error) {
		probeLog("[weave-perf] 剪贴板写入失败，请改用 text() 手动复制", error);
	}
}

export function perfReset(): void {
	samples.clear();
}

if (PROBE_ENABLED && typeof window !== "undefined") {
	(window as unknown as Record<string, unknown>).__weavePerf = {
		report: perfReport,
		reset: perfReset,
		text: perfText,
		copy: perfCopy,
	};
	// 自检锚点：重载插件后若看到这一行，说明新代码确实已加载；
	// 看不到 = 旧实例仍在内存里（或未重载），无需再猜。
	probeLog(
		`[weave-perf] 探针已加载，窗口="${String(document?.title ?? "").trim()}"；` +
			`用法：__weavePerf.reset() → 操作 → __weavePerf.copy()`
	);
}
