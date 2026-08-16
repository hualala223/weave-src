import type { App } from "obsidian";
import { findOpenEpubLeaf, pathsReferToSameOpenBook } from "../../../utils/epub-leaf-utils";
import { normalizePath } from "obsidian";

export class BookSession {
	loadToken = 0;

	constructor(options?: { cardSyncDedupeMs?: number; getEnableDebugMode?: () => boolean }) {
		void options;
	}

	dispose(): void {
		// 反链高亮索引已移除，会话无需清理其他驻留状态。
	}
}

export class BookSessionManager {
	private readonly sessions = new Map<string, BookSession>();
	private readonly options: {
		cardSyncDedupeMs?: number;
		getEnableDebugMode?: () => boolean;
	};

	constructor(options?: { cardSyncDedupeMs?: number; getEnableDebugMode?: () => boolean }) {
		this.options = options || {};
	}

	private canonicalKey(filePath: string): string {
		return normalizePath(String(filePath || "").trim());
	}

	acquire(filePath: string): BookSession {
		const key = this.canonicalKey(filePath);
		let session = this.sessions.get(key);
		if (!session) {
			session = new BookSession(this.options);
			this.sessions.set(key, session);
		}
		return session;
	}

	get(filePath: string): BookSession | null {
		return this.sessions.get(this.canonicalKey(filePath)) || null;
	}

	releaseIfNoOpenLeaves(app: App, filePath: string): void {
		const key = this.canonicalKey(filePath);
		const hasOpenLeaf = findOpenEpubLeaf(app, key) !== null;
		if (hasOpenLeaf) {
			return;
		}
		const session = this.sessions.get(key);
		if (session) {
			session.dispose();
			this.sessions.delete(key);
		}
	}

	release(filePath: string): void {
		const key = this.canonicalKey(filePath);
		const session = this.sessions.get(key);
		if (session) {
			session.dispose();
			this.sessions.delete(key);
		}
	}

	pathsShareSession(left: string, right: string): boolean {
		return pathsReferToSameOpenBook(left, right);
	}
}
