# Text Highlight → Notes Pipeline — Full Report

Repo: `N:\新建文件夹\weave-src` (package `weave-epub-reader`, "Fork Weave EPUB Reader", Foliate-based EPUB reader).
Goal of this report: document the existing **text highlight → notes** pipeline end-to-end so a similar
**image extraction → notes** feature can be designed. No code was changed. All claims cite
`file : line` and short excerpts.

---

## 1. Where highlights are created at runtime (select text → saved record)

### 1.1 Selection detection (Foliate engine)

- `src/services/epub/FoliateReaderService.ts:5283-5326` — `attachSelectionListeners(doc)` listens on the section document for `selectionchange`, `mouseup`, `touchend`, `keyup`; events are rAF-debounced into `emitSelectionChangeIfNeeded`:
  ```ts
  doc.addEventListener("selectionchange", onSelectionChange);  // :5311
  doc.addEventListener("mouseup", onMouseUp);                  // :5312
  doc.addEventListener("touchend", onTouchEnd);                // :5313
  doc.addEventListener("keyup", onKeyUp);                      // :5314
  ```
- `src/services/epub/FoliateReaderService.ts:5730-5760` — `emitSelectionChangeIfNeeded(doc)` reads the iframe selection, computes the CFI with `frame.frame.cfiFromRange(range.cloneRange())` (:5749), then `notifySelectionChange(cfiRange, frame.frame)` (:5759).
- Public subscription API: `onSelectionChange(callback)` — `src/services/epub/FoliateReaderService.ts:1629`.

### 1.2 Toolbar appears over the selection

- `src/components/epub/SelectionToolbar.svelte:690-725` — `$effect` subscribes: `currentReaderService.onSelectionChange(({ cfiRange, frame }) => void syncSelection(frame, cfiRange))` (:701-703).
- `syncSelection` — `SelectionToolbar.svelte:482-552` — grabs iframe text (`selection.toString().trim()`, :506), resolves CFI (:515), positions the toolbar (:544). `selectedText` / `currentCfiRange` state at :531-532.
- Toolbar actions that create a highlight (create mode, rendered at :896-939):
  - Color buttons → `handleHighlight(c)` — `SelectionToolbar.svelte:903`.
  - Style buttons → `handleHighlight('yellow', 'underline'|'strikethrough'|'wavy')` — :909-911.
  - "想法" (comment) → `handleCommentCreateAction()` — `SelectionToolbar.svelte:641-648` → `onCommentCreate?.(selectedText, currentCfiRange, lastUsedColor || 'yellow')` (:646).
  - "复制" (trace-copy) → `onCopyTraceLink?.(selectedText, currentCfiRange)` (:922); "AI" → `onOpenAI` (:926).
- `handleHighlight` — `SelectionToolbar.svelte:294-302`:
  ```ts
  readerService.addHighlight({ cfiRange: currentCfiRange, color, style, text: selectedText });  // :298
  onInsertToNote?.(selectedText, currentCfiRange, color, style);                                 // :300
  ```
  Note the split: the reader overlay is drawn via `readerService.addHighlight`, and the **host persistence** happens through the `onInsertToNote` / `onCommentCreate` callbacks.

### 1.3 Host wiring (EpubReaderApp)

- `src/components/epub/EpubReaderApp.svelte:2892-2911` — `<SelectionToolbar ... onInsertToNote={handleInsertToNote} onCommentCreate={handleCommentCreateOnSelection} ...>` (:2899, :2908).
- `handleInsertToNote` — `EpubReaderApp.svelte:1854-1862`:
  ```ts
  outputNote(text, cfiRange, color, style);                     // clipboard or editor insert
  void persistInlineHighlight(cfiRange, text, color, style);    // the actual persistence
  ```
- `handleCommentCreateOnSelection` — `EpubReaderApp.svelte:2348-2362`: `persistInlineHighlight(cfiRange, text, color || 'yellow', 'underline')` (:2349) then `openCommentEditor(info)` (:2361).
- **`persistInlineHighlight` — the core save path** — `EpubReaderApp.svelte:1897-1932`:
  1. `loadInlineHighlights()` reads existing records (:1905).
  2. Build record: `{ cfiRange, color, style, text, commentText: '', createdTime: Date.now(), excerptId: generateBlockID() }` (:1907).
  3. Dedup by CFI and **append**: `const dedup = arr.filter(x => x.cfiRange !== cfiRange); dedup.push(item);` (:1908-1909) → `await saveInlineHighlights(dedup)` (:1910).
  4. Build optimistic `ReaderHighlight` (:1911-1923, `sourceFile: '__inline__'`, `presentation: 'highlight'`).
  5. `pendingLoadedHighlights = mergeReaderHighlightsByIdentity(pendingLoadedHighlights, [optimistic])` (:1924-1926).
  6. `readerService.addHighlight(optimistic)` if reader ready (:1928) — draws the overlay in the book.
  7. `publishSidebarHighlights(pendingLoadedHighlights)` (:1930) — updates the notes sidebar snapshot.
- `saveInlineHighlights` — `EpubReaderApp.svelte:1875-1895`: normalizes each record, backfills `id` when missing (`hl-${excerptId||cfiRange}` sliced to 40, :1883-1887), then `storageService.saveBookHighlights(book.id, normalized)` (:1893).
- `loadInlineHighlights` — `EpubReaderApp.svelte:1865-1872` → `storageService.loadBookHighlights(book.id)`.

### 1.4 Persistence chain (see §3 for storage details)

- `src/services/epub/EpubStorageService.ts:1630-1635` `loadBookHighlights` → `getV2Store().getBook(...).notes.highlights ?? []`.
- `src/services/epub/EpubStorageService.ts:1638-1648` `saveBookHighlights` → `getV2Store().saveBookNotes(bookId, { ...aggregate.notes, highlights })` (:1644-1647).
- `src/services/epub/schema-v2-store.ts:188-192` `saveBookNotes` → `mutateBook` → `mutate` (:277-283) → throttled persist (`schedulePersist`, :310-319; `persistPending`, :321-346) → `writeUnifiedLocalDataAtomically(...)` (:334-338) writes `weave-data.json`.

### 1.5 Rendering the highlight in the book (Foliate overlay)

- `readerService.addHighlight` — `FoliateReaderService.ts:1723-1725` → `addResolvedHighlight` (:6284-6335): canonicalize location (:6288-6290), identity key (:6295), merge into `savedHighlights` dedup map (:6323-6333), `refreshHighlights()` (:6334).
- Annotation sync loop: `queueAnnotationSync` → `runQueuedAnnotationSync` — `FoliateReaderService.ts:5940-6070`; renders desired annotations vs current, diff via `isSameFoliateAnnotation` (:6048), `view.addAnnotation` (:6067) / `view.deleteAnnotation` (:6051).
- Annotation model: `src/services/epub/reader-annotation-model.ts` — `createReaderFoliateAnnotation` (:16-29) sets `value: highlight.cfiRange` (Foliate key, :23); `buildAnnotationRenderSignature` (:77-96) for diffing; `composeVisibleAnnotationHighlight` (:31-46).
- Overlay painter: `src/services/epub/reader-annotation-overlayer.ts` — `ReaderAnnotationOverlayRenderer` (:92-455): Foliate `Overlayer.highlight` fill (:104-111), styled underline/strikethrough/wavy lines (:128-153), comment-marker bubble (:176-338), reference badge (:340-454).

### 1.6 Editing / commenting an existing highlight

- Click → `setupHighlightClickHandler` — `EpubReaderApp.svelte:2018-2031`: `interactionTarget === 'comment-marker'` → `openCommentEditor(info)` (:2021-2023); else `highlightToolbarInfo = info` (:2029).
- Edit toolbar mode: `positionForHighlight` — `SelectionToolbar.svelte:554-606`; color change `onChangeColor` (:845) → `handleHighlightChangeColor` (`EpubReaderApp.svelte:2233-2253`); style change `onChangeStyle` (:854-861) → `handleHighlightChangeStyle` (:2255-2276); delete (:888) → `handleHighlightDelete` (:2195-2208) → `performHighlightDelete` (:2210-2227, `readerService.removeHighlight(info.cfiRange)` :2220); comment edit (:868) → `openCommentEditor` (:2062-2070).
- Comment editor: `src/components/epub/EpubCommentEditorPopover.svelte` — `<textarea>` (:402-411), save button `onSave` (:414) → `saveHighlightComment` (`EpubReaderApp.svelte:2282-2313`): `findInlineHighlight` (:2290), set `commentText` (:2292-2293), `saveInlineHighlights` (:2293), `readerService.addHighlight({..., commentText: draft, hasCommentDivider: true})` (:2295-2306), `reloadHighlights()` (:2309).
- Draft hydration: `hydrateCommentEditorDraft` — `EpubReaderApp.svelte:2072-2103` (refreshes `readerService` + `pendingLoadedHighlights` from source).
- Full reload: `reloadHighlights` — `EpubReaderApp.svelte:2369-2392` → `collectLocalStorageHighlights` (:2394-2422) → `readerService.applyHighlights` (:2382) → `publishSidebarHighlights` (:2384).
- Sidebar snapshot publish: `publishSidebarHighlights` — `EpubReaderApp.svelte:560-575` → `highlightViewSnapshotService.publishFromHighlights({bookId, filePath, showStrikethroughHighlights, revision, highlights, readerService})` (:565-572).

> Facade note: `src/components/epub/useEpubHighlights.ts` (17 lines) is a barrel re-export of
> `services/epub/highlight/highlight-identity.ts` and `services/epub/highlight/highlight-source-optimistic-sync.ts`,
> consumed by `EpubReaderApp.svelte:52-56` (`getReaderHighlightIdentityKey`, `hasReaderHighlightPresentationChanged`, `mergeReaderHighlightsByIdentity`).
> `highlight-source-optimistic-sync.ts` computes removed/updated highlights when a source excerpt file changes
> (`computeHighlightSourceOptimisticSync` :32-79, `applyHighlightSourceOptimisticSyncResult` :81-111) — with the vault-event wiring currently stubbed out in `EpubReaderApp.svelte:527-558` ("已断开").

---

## 2. Full data model of an annotation / highlight record

### 2.1 Persisted record — `EpubStoredHighlight` (schema v2)

`src/services/epub/schema-v2.ts:81-87`:

```ts
export interface EpubStoredHighlight extends Highlight {
	commentText?: string;      // note/comment text
	hasCommentDivider?: boolean; // whether the comment bubble is visible
	excerptId?: string;        // block-id used by trace links
	sourceFile?: string;       // source vault .md path (or '__inline__')
	sourceRef?: string;        // source block reference
}
```

Base `Highlight` — `src/services/epub/types.ts:80-89`:

```ts
export interface Highlight {
	id: string;              // REQUIRED in type; backfilled at runtime: `hl-${excerptId||cfiRange}` (EpubReaderApp.svelte:1883-1887)
	text: string;            // REQUIRED — the quoted excerpt text
	color: HighlightColor;   // REQUIRED — "yellow"|"green"|"blue"|"red"|"purple" (types.ts:91)
	style?: EpubHighlightStyle;          // OPTIONAL — "underline"|"strikethrough"|"wavy" (types.ts:32)
	chapterIndex: number;    // REQUIRED (defaulted to 0 at EpubReaderApp.svelte:1889)
	cfiRange: string;        // REQUIRED — CFI range locator
	createdTime: number;     // REQUIRED — epoch ms
	linkedNotePath?: string; // OPTIONAL — vestigial, not written by current code
}
```

Record shape actually written by `persistInlineHighlight` (`EpubReaderApp.svelte:1907`): `{ cfiRange, color, style, text, commentText: '', createdTime, excerptId }` (+ `id`, `chapterIndex` backfilled in `saveInlineHighlights` :1878-1890).

### 2.2 Runtime record — `ReaderHighlight`

`src/services/epub/reader-engine-types.ts:90-114`:

```ts
export interface ReaderHighlightInput {
	cfiRange: string;              // REQUIRED
	color: string;                 // REQUIRED
	style?: EpubHighlightStyle;    // OPTIONAL
	text?: string;                 // OPTIONAL (runtime always sets it)
	commentText?: string;          // OPTIONAL
	hasCommentDivider?: boolean;   // OPTIONAL
	chapterIndex?: number;         // OPTIONAL
	chapterTitle?: string;         // OPTIONAL
	sourceFile?: string;           // OPTIONAL
	sourceRef?: string;            // OPTIONAL
	excerptId?: string;            // OPTIONAL
	sourceLocators?: HighlightSourceLocator[]; // OPTIONAL (merged multi-source)
	createdTime?: number;          // OPTIONAL
	presentation?: ReaderHighlightPresentation; // OPTIONAL — only "highlight" (reader-engine-types.ts:20)
	pageLabel?: string;            // OPTIONAL
	pageNumber?: number;           // OPTIONAL
	referenceCount?: number;       // OPTIONAL (citation badge)
	referenceHeat?: number;        // OPTIONAL
}
export interface ReaderHighlight extends ReaderHighlightInput {
	temporary?: boolean;           // OPTIONAL — temporary flash highlight
}
```

`HighlightSourceLocator` — `reader-engine-types.ts:22-26`: `{ sourceFile: string; sourceRef?: string; excerptId?: string }`.

**Important**: the runtime `ReaderHighlight` has **no `id` field**. Identity is derived from `cfiRange` + excerpt/quote/source via `getReaderHighlightIdentityKey` — `src/services/epub/highlight/highlight-identity.ts:68-87` (`EpubLinkService.normalizeCfi` + `excerptId`, else normalized quote text, else `sourceFile\0sourceRef\0createdTime`).

### 2.3 Click/edit record — `HighlightClickInfo`

`src/services/epub/reader-engine-types.ts:70-88`: `cfiRange`, `color`, `style?`, `text`, `commentText?`, `hasCommentDivider?`, `sourceFile`, `sourceRef?`, `excerptId?`, `sourceLocators?`, `createdTime?`, `temporary?`, `presentation?`, `interactionTarget? ("highlight"|"comment-marker"|"reference-badge")`, plus geometry `rect`, `rects?`, `anchorPoint?`.

### 2.4 Sidebar display record — `EpubDisplayHighlight`

`src/services/epub/EpubHighlightViewSnapshotService.ts:9-28`: `cfiRange`, `text`, `commentText?`, `hasCommentDivider`, `commentStateLabel` ("有想法"/"无想法"), `color` (normalized), `colorLabel` (中文 label), `noteType` ("高亮"/"下划线"/"删除线"/"波浪线"), `noteTypeKey`, `tags[]`, `createdTime`, `chapterIndex?`, `chapterTitle?`, `pageLabel?` (e.g. "p.12"), `sourceFile?`, `sourceRef?`, `excerptId?`, `searchableValues[]`.
Mapping: `mapDisplayHighlight` — `EpubHighlightViewSnapshotService.ts:365-414`.

### 2.5 Container — book aggregate

`src/services/epub/schema-v2.ts:51-93`: `EpubBookAggregate { id, file: EpubBookFileRef, meta: BookMetadata, reading, notes: EpubBookNotes, ui?, audit }`; `EpubBookNotes { bookmarks: EpubBookmarkRecord[]; highlights: EpubStoredHighlight[]; excerpts: Note[] }` (:89-93).
Excerpt `Note` type — `src/services/epub/types.ts:93-101`: `{ id; content; quotedText?; chapterIndex; cfi?; createdTime; modifiedTime }` (legacy excerpt pipeline, distinct from highlights).
`BookMetadata` — `types.ts:13-30` (incl. optional `coverImage?: string`).

---

## 3. Persistence and how NotesPanel reads + orders highlights

### 3.1 Storage backend

- **Single JSON file in the vault**: `<dataPath>/weave-data.json` — `src/config/paths.ts:544-548` (`WEAVE_DATA_FILE_NAME = "weave-data.json"`; `DEFAULT_DATA_PATH = "CONFIG/STORAGE"`, :545) and :590-595 (`resolveWeaveDataFilePath`).
- Default is the literal sentinel `"CONFIG/STORAGE"` → `CONFIG/STORAGE/weave-data.json` (vault-relative), configurable via plugin settings `dataPath` (`EpubStorageService.ts:166-176`; `main.ts:54,68,174,207`; settings UI copy in `mount-epub-basic-settings.ts:26-37`).
- Writer: `SchemaV2Store` (`src/services/epub/schema-v2-store.ts`) — whole-document apply with atomic write (temp file + `adapter.rename`, :321-346; `writeUnifiedLocalDataAtomically`, `src/services/epub/epub-unified-local-data-store.ts:62-90`), 400 ms throttle (`SCHEMA_V2_PERSIST_DELAY_MS = 400`, schema-v2-store.ts:49, :310-319).
- **Not IndexedDB, not localStorage, not Obsidian `data.json`.** Grep for `indexedDB` returns nothing in `src`. `utils/vault-local-storage.ts` is a key/value facade that also converges into `weave-data.json` top-level `vaultLocalStorage` (schema-v2.ts:126; vault-local-storage.ts:65-74).
- Bookmark records share the same store (`EpubBookmarkService.getV2Store`, `EpubBookmarkService.ts:83`).

### 3.2 How NotesPanel reads highlights

- `src/components/epub/EpubGlobalSidebar.svelte:922-928` renders `<NotesPanel snapshotService={sharedState.highlightViewSnapshotService} highlightRevision={sharedState.annotationRevision} ...>` (shared state published by `EpubReaderApp.svelte:2141-2160`).
- `src/components/epub/NotesPanel.svelte`:
  - `loadAnnotations()` (:698-785) → `snapshotService.getCachedSnapshot(context)` / `hydrateFromDisk` / `revalidateSnapshot` (:644-650) → `applySnapshot(freshSnapshot.highlights)` (:654, :711, :741, :764).
  - Display list: `highlights` → `filteredHighlights` ($derived, :385) → `{#each filteredHighlights as hl}` → `EpubAnnotationCard` (:870-885).
- `EpubHighlightViewSnapshotService` (`src/services/epub/EpubHighlightViewSnapshotService.ts`) is app-scoped via `src/services/epub/epub-highlight-view-snapshot-access.ts:7-14`. It is a **session-memory-only cache** ("高亮侧栏快照只做会话内存缓存", :78-80); disk reads happen upstream through `loadBookHighlights` → `reloadHighlights` (`EpubReaderApp.svelte:2369-2392`).

### 3.3 ORDERING — where a new note lands

Two different orders exist:

1. **Persisted array order (weave-data.json) — append at the END.**
   - `persistInlineHighlight` (`EpubReaderApp.svelte:1908-1909`): `const dedup = arr.filter(...); dedup.push(item);` — the new record is pushed onto the **tail** of the array that gets written to `books[bookId].notes.highlights[]`.
   - Read-back preserves order: `loadBookHighlights` returns the array unchanged (`EpubStorageService.ts:1630-1635`); `collectLocalStorageHighlights` iterates in order (`EpubReaderApp.svelte:2398-2416`).
   - So **"最后面" (appended at the end) = the tail of the `notes.highlights` array in weave-data.json**.

2. **Rendered NotesPanel order — createdTime DESCENDING (newest first / at the TOP).**
   - `publishFromHighlights` sorts: `.sort((left, right) => (right.createdTime || 0) - (left.createdTime || 0))` — `EpubHighlightViewSnapshotService.ts:132`.
   - `revalidateSnapshot` sorts identically — `EpubHighlightViewSnapshotService.ts:234`.
   - Therefore the newest highlight (largest `createdTime`) is rendered **first** in the sidebar list. New entries do **not** appear at the visual end; they appear at the visual top (the end of the *array*).
   - Ties (equal `createdTime`) keep the underlying array order (stable sort), where `mergeReaderHighlightsByIdentity` (`highlight-identity.ts:176-190`) appends new identity keys after existing ones.
- For comparison, bookmarks are also sorted newest-first at read time: `EpubBookmarkService.loadBookmarksForBook` — `EpubBookmarkService.ts:106-114` (`.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))`).
- `EpubBookmarksPanel.svelte` (:95-121) renders bookmarks in that stored order (no extra sort).

**Design implication for an image-extraction feature**: if you mirror the highlight pipeline, a new image note is appended to the persisted `notes.highlights` array (or a sibling array) at its end, but the visible list will show it at the top unless you change the sort or set `createdTime` accordingly.

---

## 4. Every mechanism by which note content leaves the reader (vault writes)

### 4.1 Vault file writing — audit result

- **The only vault write in `src/` is `weave-data.json`** (data file), via `adapter.write` in `writeUnifiedLocalDataAtomically` — `src/services/epub/epub-unified-local-data-store.ts:70-89` (temp write :70, rename :72, fallback direct write :77/:89). It is called only from `SchemaV2Store.persistPending` (`schema-v2-store.ts:334-338`) and its V1-compat peers.
- Grep for `app.vault.create` / `app.vault.modify` / `vault.createBinary` / `adapter.write` finds **no markdown-note or image-file writing code**. The `Object.create(...)` hits are test mocks (`Object.create(TFile.prototype)` etc.).
- **The plugin does NOT automatically write any markdown notes file to the vault.** All annotation data lives in-app inside `CONFIG/STORAGE/weave-data.json` (default) / the configured `dataPath`.

### 4.2 Content that leaves the reader (user-triggered only)

- `outputNote` — `EpubReaderApp.svelte:1844-1852`: builds content, then either `insertToEditorAndTrack` (auto-insert mode) or `copyTextToClipboard`.
- `insertToEditor` — `EpubReaderApp.svelte:1812-1829`: finds the last active Markdown leaf and calls `editor.replaceRange(content + '\n', cursor)` (:1825) — writes **into an already-open markdown document**, driven by the user's auto-insert toggle, not a background vault write.
- `copyTextToClipboard` — `EpubReaderApp.svelte:1835-1842` (`navigator.clipboard.writeText`).
- `buildNoteContent` — `EpubReaderApp.svelte:1782-1806` → `linkService.buildQuoteBlock(...)`.
- **Quote-block markup** — `src/services/epub/EpubLinkService.ts:837-880`:
  ```ts
  return `> [!EPUB${calloutMeta}] ${link}${titleSuffix}\n${quotedLines}\n`;   // :879
  ```
  where `link` is `[[linkPath#subpath|displayText]]` (`buildEpubLink`, :809-835) and quoted text is prefixed `> ` per line (:875-878).
- **Deep-link formats** (`EpubLinkService.ts`):
  - Vault wikilink locator: `[[{linkPath}#{cfi-subpath}|{alias}]]` — :834. Subpath embeds CFI, optional `weave-loc=` compact payload, `excerptId` (`buildLocatorSubpath` :824-833; parsing at `parseEpubLink` :950+).
  - `obsidian://` protocol: `buildObsidianProtocolHref` :700-726 → `obsidian://{protocol}?file=...&cfi=...&chapter=...&sid=...&text=...`; `buildObsidianProtocolHrefForChapter` :728-752.
  - Copy actions enum + formatters: `buildSelectionCopyLink` :882-921 (protocolMarkdown / vaultWikilink / obsidianUri / plainText).
- `EpubLinkPostProcessor` — `src/services/epub/EpubLinkPostProcessor.ts:204-228`: only **binds click handlers** on existing `<a>` links in rendered markdown (`bindEpubLocatorLink`), styles them (:230-249); it performs no vault IO.

### 4.3 Other files checked (all read-only / settings)

- `src/services/epub/epub-excerpt-settings.ts` (17 lines) — pure settings type `EpubExcerptSettings { addCreationTime, chapterLocationFormat, strikethroughDisplayMode, showStrikethroughInSidebar }`; no IO.
- `src/utils/plugin-access.ts` — reads other plugins (`app.plugins.getPlugin`, e.g. legacy `weave`) for settings/data-storage compatibility (:53-115); no IO.
- `src/utils/vault-image-cover.ts` — read-only: `resolveVaultImageResourceUrl` uses `app.vault.getResourcePath(file)` (:37) for vault image files (extensions list :4-18).
- `src/config/paths.ts` — pure path computation.

---

## 5. Image / media support in the annotation & note model

### 5.1 Annotation model — no image fields today

- `ReaderHighlight` / `ReaderHighlightInput` (`reader-engine-types.ts:90-114`), `EpubStoredHighlight` (`schema-v2.ts:81-87`), `EpubDisplayHighlight` (`EpubHighlightViewSnapshotService.ts:9-28`), `HighlightClickInfo` (:70-88) — **all text-only**. There is no image/media field anywhere in the highlight→notes pipeline. A highlight record cannot carry an image today.
- `Note` type (`types.ts:93-101`) is also text-only.

### 5.2 `EpubBinaryData.ts` — what it is used for

`src/services/epub/EpubBinaryData.ts` (345 lines): reads the **whole EPUB container binary** from the vault — `readVaultBinaryData(app, file, context)` (:232-345), with fallback strategies `vault.readBinary` → `vault.adapter.readBinary` → `vault.getResourcePath` + XHR (:193-226), ZIP-signature validation (:89-97, :145-147). It is imported **only** by `FoliateVaultPublicationParser` (`FoliateVaultPublicationParser.ts:14`, calls at :239, :287) to load the book file. It is **not** part of the annotation pipeline. (Its ArrayBuffer normalization helpers could conceptually be reused for image bytes, but nothing does so today.)

### 5.3 Cover art storage

- Extracted at parse time as a **base64 data-URL string**: `FoliateVaultPublicationParser` → `coverImage: (await this.extractCoverDataUrl()) || undefined` (`FoliateVaultPublicationParser.ts:333`), held in `BookMetadata.coverImage?: string` (`types.ts:27`).
- **Deliberately NOT persisted** into weave-data.json: `SchemaV2Store.upsertBook` strips `coverImage` before saving (`schema-v2-store.ts:75-80` "封面改为由运行时动态解析", applied at :176-177; verified by test `schema-v2-store.test.ts:92-107`).
- Rendered with an `<img>` tag: `EpubGlobalSidebar.svelte:732-733` (`<img src={sharedState.book.metadata.coverImage} ... class="sidebar-cover">`).
- Bookshelf covers: dynamically resolved from vault image files via `resolveVaultImageResourceUrl` (`BookshelfView.svelte:589, 681, 1433`) and scan-index `coverImage` (`epub-local-data-types.ts:28`).

### 5.4 `blob-url-registry.ts` — the closest reusable media mechanism

`src/utils/blob-url-registry.ts` (212 lines): patches `URL.createObjectURL` / `URL.revokeObjectURL` so Foliate section `load()` blobs survive revocation (`installBlobUrlRegistry`, :159-192; auto-installed at module load, :210-212; imported at `main.ts:2`). It retains `Blob` objects per URL and can read them back:
- `readRegisteredBlobAsText(url)` — :85-98 (text of a book section / CSS).
- `readRegisteredBlobAsArrayBuffer(url)` — :100-115 → `{ bytes: Uint8Array, mimeType: string }`.
- `getCachedBlobBinary(url)` — :59-64; `collectBlobResourceUrls(source)` — :23-32 (finds `blob:` URLs in HTML/CSS).

**This is the existing mechanism that knows how to obtain image bytes of EPUB content**: book images are `blob:` URLs inside Foliate sections; the registry retains them and can return `Uint8Array` + mime type. A future image-extraction feature could reuse `readRegisteredBlobAsArrayBuffer` (or a new resolver that finds `<img>` elements' `src` blob URLs inside the section DOM).

### 5.5 Other related types

- `src/data/epub-bridge-types.ts` (14 lines) — only `Card { uuid, content, deckId?, sourceFile?, customFields?, [key]: unknown }`; no image field (the index-signature `[key: string]: unknown` is the only "anything goes" escape hatch).
- `src/data/types.ts` — only `Card` re-export + `SearchableCard` fields (`tags/content/priority/sourceFile/fsrs/ir_state/scheduleStatus/stats/created/modified`); no image.
- `src/types/foliate-js.d.ts` (3 lines) — bare module declarations only; **no Foliate annotation types** are declared, so `FoliateAnnotation` in `FoliateReaderService.ts:1890` etc. is effectively untyped (`any`-ish).
- Related blob helpers: `src/utils/blob-url-text.ts` (readResourceUrlAsArrayBuffer :168) used by `EpubBinaryData` (:3) and `foliate-runtime-patches.ts` / `foliate-blob-markup-normalizer.ts` (:9-10) — again book-content plumbing, not annotations.

---

## 6. How NotesPanel renders entries (can it show an `<img>`?)

### 6.1 Rendering

- `NotesPanel.svelte:870-885` — renders one `EpubAnnotationCard` per filtered highlight, passing **plain strings only**:
  ```svelte
  <EpubAnnotationCard ... color={hl.color} quoteText={hl.text}
    commentText={hl.hasCommentDivider ? (hl.commentText || '想法为空') : getEmptyExcerptHint(hl.text)}
    commentMuted={!hl.hasCommentDivider} metaLeft={getSourceLabel(hl.sourceFile)}
    metaRightPrefix={formatTime(hl.createdTime)} metaRight={hl.pageLabel || getHighlightChapterLabel(hl)} />
  ```
- `EpubAnnotationCard.svelte` props (:4-21): `color, quoteText, quoteHtml, commentText, commentHtml, metaLeft, metaRightPrefix, metaRight, metaRightPageLabel, metaRightTime, clickable, selectionMode, selected, onActivate, onContextMenu, commentMuted`.
- Quote/comment rendering (:104-124): if `quoteHtml`/`commentHtml` are provided they are injected with **`{@html ...}`** (unsanitized, :107, :120); otherwise the plain-text props are interpolated. `hasQuote = Boolean(quoteHtml || quoteText)` (:55).
- **There is no `<img>` anywhere in the notes pipeline today** — but the `quoteHtml`/`commentHtml` props mean an image note could be rendered by passing HTML containing `<img>` (with the usual `{@html}` XSS caveat) or by extending the card with an image slot/prop. The card component itself is the seam: adding an `imageUrl?: string` prop would be a small, contained change.

### 6.2 Card CSS

- Card styles: `EpubAnnotationCard.svelte:184-419` — `.weave-annotation-card` (rounded 15px card, gradient background, border/shadow, :185-209), `.clickable`/`.selected` states (:211-242), `.annotation-quote` (colored panel, :286-300), color classes `.hl-yellow` / `.hl-green` / `.hl-blue` / `.hl-red` / `.hl-purple` (:382-410), `.annotation-comment` + `.annotation-comment-muted` (:322-330), header/meta pills (:254-380), `mark` styling inside quote/comment (:412-418).
- Panel CSS: `NotesPanel.svelte:892-1034` — `.epub-notes-panel` (flex column, padding, :900-908), `.notes-section` / `.notes-section-list` (flex column, gap 12px, :1023-1033), `.epub-placeholder` (:1014-1021), selection-mode float bar (:914-1005), sync hint (:893-898).
- Bookmark cards have their own styles in `EpubBookmarksPanel.svelte:193-375` (separate component, not used for highlights).

---

## 7. CONTEXT / ADR documentation

- **No** `CONTEXT.md`, `CONTEXT-MAP.md`, `AGENTS.md`, or `CLAUDE.md` anywhere in the repo (glob over the whole tree returned nothing).
- **No** `docs/` directory and **no** `docs/adr/` (glob `docs/**` returned nothing).
- Repo-level docs that do exist: `README.md` (+ localized README.*.md), `PRIVACY.md`, `SECURITY.md`, `SUPPORT.md`, `PREMIUM_TERMS.md`, `LICENSE`, `COPYRIGHT`, and per-version notes in `.github/release-notes/0.6.*.md`. Design knowledge lives in code comments (Chinese) — notably the header comments in `schema-v2.ts:1-10`, `schema-v2-store.ts:1-16`, and `config/paths.ts:1-69`.

---

## Appendix A — Key call chain (text highlight)

```
User selects text
  → FoliateReaderService.attachSelectionListeners (FoliateReaderService.ts:5283) 
      → emitSelectionChangeIfNeeded (:5730) → cfiFromRange (:5749) → onSelectionChange (:1629)
  → SelectionToolbar $effect (:701) → syncSelection (:482) → toolbar shown (:544)
User taps color/style/想法
  → handleHighlight (:294) → readerService.addHighlight (:298)  [overlay]
      → onInsertToNote (:300) → EpubReaderApp.handleInsertToNote (:1854)
          → outputNote (:1844) [clipboard / editor insert]
          → persistInlineHighlight (:1897)
              → loadInlineHighlights (:1865) → storageService.loadBookHighlights (EpubStorageService.ts:1630)
              → build record {cfiRange,color,style,text,commentText,createdTime,excerptId} (:1907)
              → dedup.push(item)  ← appended at END of persisted array (:1908-1909)
              → saveInlineHighlights (:1875) → storageService.saveBookHighlights (:1638)
                  → SchemaV2Store.saveBookNotes (schema-v2-store.ts:188) → mutate → throttled atomic write of weave-data.json (:310-346)
              → mergeReaderHighlightsByIdentity (:1924) → readerService.addHighlight (:1928)
              → publishSidebarHighlights (:1930) → publishFromHighlights (EpubHighlightViewSnapshotService.ts:104)
                  → sort createdTime DESC (:132) → NotesPanel renders newest-first (:870)
```

## Appendix B — Where an image field would need to touch

1. **Model**: `EpubStoredHighlight` (schema-v2.ts:81) / `ReaderHighlightInput` (reader-engine-types.ts:90) — add e.g. `imageUrl?`/`imageData?`; schema-v2-store persists `notes.highlights` verbatim, so new fields persist automatically (but watch `stripPersistedBookMetadataCover`-style size policy for base64 blobs, schema-v2-store.ts:75-80).
2. **Create path**: `persistInlineHighlight` (EpubReaderApp.svelte:1897) is the single write point for text highlights; an image variant would parallel it (or generalize it).
3. **Bytes**: `readRegisteredBlobAsArrayBuffer` (blob-url-registry.ts:100) can fetch `Uint8Array`+mime for `blob:` content images; `collectBlobResourceUrls` (:23) finds them.
4. **Display**: `EpubAnnotationCard` props (EpubAnnotationCard.svelte:4-21) — no img support yet; `NotesPanel.svelte:870-885` passes only text.
5. **Ordering**: persisted array append-at-end vs. rendered `createdTime` DESC (EpubHighlightViewSnapshotService.ts:132/234) — decide which semantics "appended at the end" should mean for the new feature.
