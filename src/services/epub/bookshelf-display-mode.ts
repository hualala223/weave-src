export type BookshelfSurfaceContext = "main" | "sidebar";

export type BookshelfDisplayMode = "adaptive" | "list" | "grid" | "covers";

export type ResolvedBookshelfViewMode = Exclude<BookshelfDisplayMode, "adaptive">;

export interface BookshelfDisplayModeOption {
	mode: BookshelfDisplayMode;
	label: string;
	description: string;
	icon: string;
}

export const DEFAULT_BOOKSHELF_DISPLAY_MODE: BookshelfDisplayMode = "list";

const BOOKSHELF_DISPLAY_MODE_META: Array<Pick<BookshelfDisplayModeOption, "mode" | "icon">> = [
	{ mode: "adaptive", icon: "sparkles" },
	{ mode: "list", icon: "list" },
	{ mode: "grid", icon: "layout-grid" },
	{ mode: "covers", icon: "library" },
];

const BOOKSHELF_DISPLAY_MODE_LABELS: Record<BookshelfDisplayMode, { label: string; description: string }> = {
	adaptive: { label: "跟随位置", description: "侧边栏列表，内容区卡片。" },
	list: { label: "列表详情", description: "突出标题、作者、标签和进度。" },
	grid: { label: "卡片网格", description: "显示封面与关键信息。" },
	covers: { label: "仅看封面", description: "切换到纯封面书墙。" },
};

function buildBookshelfDisplayModeOption(mode: BookshelfDisplayMode, icon: string): BookshelfDisplayModeOption {
	return {
		mode,
		icon,
		label: BOOKSHELF_DISPLAY_MODE_LABELS[mode].label,
		description: BOOKSHELF_DISPLAY_MODE_LABELS[mode].description,
	};
}

export function getBookshelfDisplayModeOptions(): BookshelfDisplayModeOption[] {
	return BOOKSHELF_DISPLAY_MODE_META.map((option) =>
		buildBookshelfDisplayModeOption(option.mode, option.icon)
	);
}

export function normalizeBookshelfDisplayMode(value: unknown): BookshelfDisplayMode {
	return BOOKSHELF_DISPLAY_MODE_META.some((option) => option.mode === value)
		? (value as BookshelfDisplayMode)
		: DEFAULT_BOOKSHELF_DISPLAY_MODE;
}

export function resolveBookshelfViewMode(
	mode: BookshelfDisplayMode,
	surfaceContext: BookshelfSurfaceContext
): ResolvedBookshelfViewMode {
	if (mode === "adaptive") {
		return surfaceContext === "sidebar" ? "list" : "grid";
	}
	return mode;
}

export function getBookshelfDisplayModeOption(
	mode: BookshelfDisplayMode
): BookshelfDisplayModeOption {
	const resolvedMeta =
		BOOKSHELF_DISPLAY_MODE_META.find((option) => option.mode === mode) ?? BOOKSHELF_DISPLAY_MODE_META[0];
	return buildBookshelfDisplayModeOption(resolvedMeta.mode, resolvedMeta.icon);
}
