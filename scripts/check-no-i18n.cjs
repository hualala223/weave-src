// 零 i18n 残留检查：断言 src/ 下不存在任何多语言框架引用。
// 用法：node scripts/check-no-i18n.cjs
// 失败时 exit 1（CI 硬性门禁）。
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");

// 这些符号 / 路径出现即视为 i18n 残留
const RESIDUE_PATTERNS = [
	/utils\/i18n/,
	/\bi18n\.t\(/,
	/\bcurrentLanguage\b/,
	/\binitI18n\b/,
	/\bsyncI18n\b/,
	/\bInterfaceLanguage\b/,
	/\bZH_CN_STRINGS\b/,
	/\bI18nService\b/,
	/\btranslationCatalog\b/,
	/\bflattenTranslationLeafKeys\b/,
	/\btrArray\b/,
	/\btrState\b/,
	/\$tr\b/,
];

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__tests__") continue;
			walk(full, out);
		} else if (/\.(ts|svelte|js|cjs|mjs)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function main() {
	const files = walk(SRC_DIR);
	const violations = [];
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		for (const pattern of RESIDUE_PATTERNS) {
			const match = pattern.exec(text);
			if (match) {
				violations.push(`${path.relative(PROJECT_ROOT, file).replace(/\\/g, "/")}: ${pattern}`);
				break;
			}
		}
	}
	if (violations.length > 0) {
		console.error("[check-no-i18n] 发现 i18n 残留：");
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log(`[check-no-i18n] OK — ${files.length} 个源文件零 i18n 残留`);
}

main();