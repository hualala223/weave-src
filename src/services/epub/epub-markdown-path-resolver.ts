import type { App } from "obsidian";
import { normalizePath } from "obsidian";

function normalizeFolderPath(folderPath?: string | null): string {
	const raw = String(folderPath || "")
		.trim()
		.replace(/\\/g, "/");
	if (!raw || raw === "." || raw === "/") {
		return "/";
	}

	return normalizePath(raw);
}

export async function generateUniqueVaultFilePath(
	app: App,
	folderPath: string,
	fileName: string
): Promise<string> {
	const normalizedFolder = normalizeFolderPath(folderPath);
	const normalizedFileName = String(fileName || "").trim();
	if (!normalizedFileName) {
		throw new Error("file-name-required");
	}

	const lastDot = normalizedFileName.lastIndexOf(".");
	const baseName = lastDot > 0 ? normalizedFileName.slice(0, lastDot).trim() : normalizedFileName;
	const extension = lastDot > 0 ? normalizedFileName.slice(lastDot) : "";
	const baseCandidate =
		normalizedFolder === "/"
			? normalizedFileName
			: normalizePath(`${normalizedFolder}/${normalizedFileName}`);

	if (!(await app.vault.adapter.exists(baseCandidate))) {
		return baseCandidate;
	}

	for (let index = 2; index <= 500; index++) {
		const nextFileName = `${baseName} ${index}${extension}`;
		const nextCandidate =
			normalizedFolder === "/"
				? nextFileName
				: normalizePath(`${normalizedFolder}/${nextFileName}`);
		if (!(await app.vault.adapter.exists(nextCandidate))) {
			return nextCandidate;
		}
	}

	const fallbackFileName = `${baseName}-${Date.now()}${extension}`;
	return normalizedFolder === "/"
		? fallbackFileName
		: normalizePath(`${normalizedFolder}/${fallbackFileName}`);
}
