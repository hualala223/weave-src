# Feasibility: "Tap an in-book image → extract bytes, metadata, location → store as a note entry"

**Codebase:** `weave-epub-reader` (Fork Weave EPUB Reader, built on [Foliate](https://github.com/johnfactotum/foliate-js) 1.0.1).
**Task style:** pure investigation — no code was changed in producing this report.

This report answers the five investigation questions, then gives a per-sub-question
FEASIBILITY verdict and the exact files that must be touched to implement the feature.

All line references are to files under `N:\新建文件夹\weave-src\`. The `.epub` file itself
lives inside the Obsidian vault (it is read via `app.vault.readBinary`), and the plugin
keeps a JSZip in-memory archive of it while the book is open.

---

## 1. How EPUB content is rendered at runtime (the content DOM + how to reach `<img>`)

### Each chapter renders inside an iframe; the chapter DOM is the iframe's `document`.

- `src/services/epub/FoliateReaderService.ts:546` – creates the host element:
  `const view = activeWindow.createEl("foliate-view") as FoliateViewElement;` then
  `container.appendChild(view)` (`:554`) and `view.open(this.parser.getBook())` (`:558`).
  Foliate's `foliate-view` (from `foliate-js/view.js`, imported at `:453`) hosts the
  paginator, which places each section's content in a sandboxed `iframe`. This is confirmed
  by the patch script `scripts/patch-foliate-paginator.mjs:176-190` (SANDBOX_PATCHES) which
  edits `paginator.js` / `fixed-layout.js` iframe `sandbox` attribute handling, and by the
  patch at `scripts/patch-foliate-paginator.mjs:212` (`this.addEventListener('load', ({ detail: { doc } })...`) —
  the `load` event detail carries the section `doc`, i.e. the iframe's document.
- The reader explicitly tests events "in-frame": `src/services/epub/reader-tap-zones.ts:12-13`
  comment — *"EPUB 内容渲染在 iframe 中，事件不会冒泡到宿主，因此监听器必须挂到每个 frame document 上
  （与 foliate-paginator 自身的 touch 监听、本服务的 attachSelectionListeners 同一模式）。"*
  (EPUB content is rendered in an iframe; events do not bubble to the host, so listeners must
  be attached to each frame document.)

### The chapter content lives in the **per-chapter iframe document**, reachable as `frame.frameDocument`.

- `src/services/epub/FoliateReaderService.ts:148-154` — `VisibleFrameWithIndex` carries
  `frameDocument: Document`, `frameElement: HTMLElement`, `frame: ReaderFrame`.
- `getVisibleFramesWithIndex()` (`:2978-3003`) walks `foliateView.renderer.getContents()`
  (`getFoliateVisibleContents`, `:2960-2976`) and for each item captures:
  `frameDocument: doc` and `frameElement: (doc.defaultView.frameElement ...) || null` (`:2996-2998`).
  `doc.defaultView.frameElement` is exactly the `<iframe>` that holds the chapter.
- Each `VisibleFrameWithIndex` also carries `href` resolved by chapter index
  (`:2995` → `parser.getSectionHrefByIndex(index)`), so a clicked image's chapter href is
  available on the frame.
- `ReaderFrame` (`reader-engine-types.ts:145-149`) carries `frameDocument`, `window`, and
  `cfiFromRange` — the exact primitive needed to turn a node/range in the content DOM into a CFI.

### Existing pattern: attach DOM listeners to each frame document on `load`.

- `src/services/epub/FoliateReaderService.ts:1829-1852` — `handleLoadEvent` fires per chapter load:
  ```
  1833: const detail = (event as CustomEvent<{ doc?: Document; index?: number }>).detail;
  1834: const doc = detail?.doc;
  1841: this.loadedDocumentSectionIndexes.set(doc, index);
  1843: this.normalizeDocument(doc);
  1844: this.attachSelectionListeners(doc);
  1845: this.attachHighlightClickListeners(doc);
  1846: this.attachWheelListeners(doc);
  1847: this.attachTapZoneListeners(doc);
  ```
  Each `attach*Listeners(doc)` binds listeners directly onto the frame `Document` and stores a
  cleanup in a `Map<Document, () => void>` (e.g. `documentSelectionCleanups` `:371`,
  `documentTapZoneCleanups` `:374`, torn down in `destroyAll` at `:6788-6803`).
  **This is the template to follow for attaching a per-frame `<img>` click/capture listener.**
- `attachSelectionListeners` (`:5283-5326`) binds `selectionchange`/`mouseup`/`touchend`/`keyup`
  directly on `doc` and schedules a frame-throttled emit — shows events are reliably readable
  from the host even though the content is in an iframe (the host and iframe are same-origin
  here; the sandbox `allow-same-origin` is preserved — see patch at
  `scripts/patch-foliate-paginator.mjs:181` where `allow-same-origin` stays).
- `attachTapZoneListeners` (`:5328-5334`) delegates to `reader-tap-zones.ts:attach(doc)`
  (`reader-tap-zones.ts:161-330`), which binds `touchstart/touchmove/touchend/touchcancel/selectionchange`
  directly on `doc` and performs hit reasoning in when-frame coordinates.

### Click routing currently: links are intercepted via the Foliate `link` event, not DOM click.

- `handleLinkEvent` (`:1854-1878`) intercepts footnote anchors from the Foliate `link` event
  (`:550` registers `view.addEventListener("link", this.handleLinkEvent ...)`) and calls
  `anchor.ownerDocument`/`anchor.textContent`. This proves the host routinely inspects a
  clicked element that lives inside the frame DOM.
- `svg-interaction.ts` (`src/services/epub/svg-interaction.ts:1-14`) is a tiny helper that sets
  `pointer-events`/`cursor` attributes on SVG inside content — evidence that scripted
  interaction with in-chapter elements is already done at the DOM-attribute level.

> **Bottom line:** content is one `<iframe>`-hosted `Document` per chapter; you reach in-book
> `<img>` elements and their clicks exactly like the existing highlight/selection/tap plumbing:
> from a `VisibleFrameWithIndex.frameDocument`, same-origin, attaching listeners in
> `handleLoadEvent`. No new cross-origin / shadow-DOM machinery is required.

---

## 2. How in-book images are resolved at runtime (blob URLs, the archive, href mapping)

### Two different resource pipelines feed Foliate: the EPUB-archive loader and the generic-book loader.

**EPUB (`.epub`) — resources come from a JSZip in-memory archive, served to Foliate through blob URLs.**

- `src/services/epub/FoliateVaultPublicationParser.ts:191-197` — the parser owns
  `private archive: JSZip | null` and `private manifestMediaTypeByHref`, plus an
  `archiveEntryLookup`.
- `:238-256` — for `.epub`: `readVaultBinaryData(...)`, then
  `this.archive = await JSZip.loadAsync(normalizedBinary, ...)` (`:244`). So the **entire
  .epub archive is held in memory (JSZip)** for the book's lifetime.
- `:878-918` — `createFoliateLoader()` is the bridge from archive entries to Foliate. Its
  `loadBlob(name, type?)` (`:900-909`) looks up an entry with `findArchiveEntry(normalizedHref)`
  (`:902`), `entry.async("uint8array")` (`:906`), and wraps the bytes in
  `new Blob([normalizedBytes], { type })` (`:908`). Foliate then turns these Blobs into
  `blob:` resource URLs (createObjectURL) which are what `<img src>` actually points at.
- Manifest media-type → href map is built in `buildManifestMediaTypeLookup` (`:939-966`, keyed
  via `this.manifestMediaTypeByHref.set(normalizedHref, mediaType)` at `:966`).
- The plain-text and generic-book adapters (`:272-300`) set `this.archive = null` — for those,
  resources come not from a JSZip archive but from Foliate's own `makeBook`/section loaders.

**On desktop, chapter iframes are rendered from `blob:` HTML; `srcdoc` normalization inlines blob resources.**

- `src/services/epub/foliate-runtime-patches.ts:90-152` — `installFoliateBlobIframePatch` patches
  `HTMLIFrameElement.prototype.src` setter so any `blob:` iframe `src` is read
  (`readTextFromResourceUrl`, `:10-15`) and driven through `inlineFoliateBlobMarkup` to
  normalize/sanitize it (`:119-139`).
- `src/services/epub/foliate-blob-markup-normalizer.ts:258-269` — `inlineFoliateBlobImages`:
  for each `img[src]` whose src starts with `blob:`, it reads the blob as binary
  (`readBlobResourceAsDataUrl`, `:159-169`) and **rewrites the `<img src>` to a `data:` URI**
  (`imageElement.setAttribute("src", dataUrl)`, `:266`). So in the *reader-rendered* chapter
  DOM, an in-book image's `src` is usually a **`data:` URI**, not a `blob:` URL — important for
  design (see §3).

### How `<img src>` maps back to a manifest item / href.

- There is **no existing reverse map from `src` (blob- or data-URI) → manifest href**. The
  project tracks href → archive entry (JSZip) and href → media type, but nothing from a live
  `<img>` src back to the href.
- The forward path is `findArchiveEntry` (`:3462-3483`) and `getArchivePathCandidates`
  (`:3503-3515`), which resolve a normalized archive path to a `JSZip.JSZipObject`.
- A captured image therefore needs either:
  - walking from the `<img>` to its nearest `href`-bearing context (an `<a>` parent or a
    `<figure>`, caption, sibling) and the chapter href from the frame (`frame.href`), then
    joining relative `src` against the chapter href via `resolveHrefAgainst`/`normalizeInternalHref`
    (`:421-423`, `:3434-3456`); or
  - a **new** `src → href`/`src → archive-entry` index built by scanning the processed/raw
    chapter markup before load (the markup normalizer already scans all `img[src]` at
    `foliate-blob-markup-normalizer.ts:259`, and `loadProcessedDocumentByHref` at
    `FoliateVaultPublicationParser.ts:1608-1653` parses the per-href markup).
- `manifestMediaTypeByHref` (`:195`, populated `:966`) and `inferMimeType` (`:3598-3605`)
  let you recover the media type once you have the href.

> **Bottom line:** for `.epub` books the source of truth is the in-memory JSZip archive plus
> manifest media-type map keyed by archive href. The rendered `<img>` usually carries a
> `data:` (or revocable `blob:`) URL, not the href, so a **src→href mapping step is required**,
> but all building blocks (archive lookup, href normalization, media-type inference) already exist.

---

## 3. Can the ORIGINAL bytes of an in-book image be fetched (from archive / vault)?

**Yes — three independent byte paths exist, any of which can yield the original image bytes.**

1. **From the in-memory JSZip archive (most direct for `.epub`):**
   - `FoliateVaultPublicationParser.findArchiveEntry(path): JSZip.JSZipObject`
     (`:3462-3483`) → then `entry.async("uint8array")` (used at `:906-907` in `loadBlob`,
     and `entry.async("text")` at `:890`/`:1631`). Given the manifest href of the clicked
     image, `findArchiveEntry(href).async("uint8array")` yields the original bytes and the
     media type from `inferMimeType(href)` (`:3598`). This is the exact inverse of the loader
     that produced the blob.
   - `this.archive.file(candidate)` / `this.archive.file(matchedPath)` (`:3467`, `:3477`).

2. **From the vault `.epub` file itself** (valid if the archive was never mutated):
   - `src/services/epub/EpubBinaryData.ts:232-344` — `readVaultBinaryData(app, file, context, opts)`
     returns a `Uint8Array` of the whole `.epub`, trying `vault.readBinary` (`:197`),
     `vault.adapter.readBinary` (`:204-209`), and `vault.getResourcePath` + XHR (`:212-223`),
     with ZIP-signature/CRC validation and best-candidate selection. Re-run `JSZip.loadAsync`
     on it to fetch the image entry.
   - Vault path of the book is available as `this.filePath` (`FoliateVaultPublicationParser:198`)
     and from the book (`EpubStorageService` scans vault paths, e.g.
     `src/services/epub/EpubStorageService.ts:441-453`).

3. **From the rendered blob / data URI directly:**
   - `src/utils/blob-url-registry.ts:159-192` — `installBlobUrlRegistry()` wraps
     `URL.createObjectURL`/`revokeObjectURL` so every blob created (including Foliate resource
     blobs) is retained in `blobByUrl`, with text and binary caches
     (`cacheBlobBinary`, `:74-83`; `getRegisteredBlob`, `:46-49`). So if the `<img src>` is a
     retained blob URL, `getRegisteredBlob(src)` gives the original `Blob` without any fetch.
   - `src/utils/blob-url-text.ts:123-140` — `readResourceUrlAsArrayBuffer` /
     `readResourceUrlAsBinary` read a resource URL (blob or vault `app://`) as bytes via XHR,
     with a blob-binary cache (`readBlobUrlAsArrayBuffer`, `:159-176`).
   - For `data:` URLs (the common case after `inlineFoliateBlobImages`), bytes are trivially
     decoded from the `data:` payload, or — better — short-circuit to path **1 (archive)**
     using the href for the true original.

> **Bottom line:** everything exists to produce the original bytes. For `.epub` the cleanest
> path is `findArchiveEntry(href).async("uint8array")` + `inferMimeType(href)`; the blob
> registry is a working fallback when the `src` is a retained blob URL. Generic (MOBI/AZW3)
> books have resources inlined in `section.load()` HTML (see `:1663-1715`), so byte extraction
> there is more brittle (see verdict).

---

## 4. Existing image handling anywhere (copy to vault / base64 / data URI)

- **Cover extraction:** `FoliateVaultPublicationParser.extractCoverDataUrl()` (`:1226-1234`)
  calls `getBook().getCover?.()` and converts the returned `Blob` to a `data:` URL via
  `blobToDataUrl` (`:3093-3101`, FileReader → `readAsDataURL`). The result is stored as
  `coverImage` on the loaded publication (`:333`) and consumed by the bookshelf
  (`EpubStorageService` passes `metadata.coverImage` around; `:671`), with `BookshelfCoverTile.svelte`
  rendering `<img src={coverUrl}>` (`src/components/epub/BookshelfCoverTile.svelte:63-64`).
  This is a **complete working reference flow: in-book image → blob → data URI → display**,
  though it targets only the cover, not arbitrary in-book figures.
- **Blob→data-URI / binary inlining of in-book images:** `foliate-blob-markup-normalizer.ts`
  — `readBlobResourceAsDataUrl` (`:159-169`), `blobToDataUrl` (`:149-157`), and
  `inlineFoliateBlobImages` (`:258-269`) already read in-book image blobs as binary and emit
  data URIs. This is the closest existing "extract in-book image bytes" logic, but it feeds the
  render pipeline rather than a note.
- **Binary read utilities:** `blob-url-text.ts:123-140` (arrayBuffer/binary), the blob registry
  (§3), and `EpubBinaryData` (§3) cover the binary plumbing.
- **Cover for bookshelf (that also reads binary):** `utils/vault-image-cover.ts:25-41` maps a
  vault image file to its resource URL via `app.vault.getResourcePath`, and `BookshelfCoverTile`
  renders it — the vault-side analogue, but for already-external images, not in-archive ones.
- **Persistence schema for notes (where an image note would be stored):**
  - `src/services/epub/schema-v2.ts:89-93` — `EpubBookNotes { bookmarks, highlights, excerpts }`;
    `excerpts: Note[]`. An image entry could be added as a new `Note`-typed excerpt with the
    image bytes/URI + caption + href + CFI.
  - `src/services/epub/EpubStorageService.ts` persists per-book aggregates in
    `weave-data.json` (`getFilePath`/`DirectoryUtils.ensureDirForFile`, `:184`; highlights at
    `:1629-1634`, `saveBookHighlights`/`loadBookHighlights`), and has live vault-write
    machinery (`app.vault.createBinary`/`create`, `DirectoryUtils`, `adapter.*`) used for
    artifact/cleanup paths (e.g. `:1556-1560`, `:2062-2091`). Writing an extracted image into
    the vault as a binary file would reuse these.
- **The note-output plumbing for the analog text-highlight feature (the model to mirror):**
  - `src/components/epub/EpubReaderApp.svelte:1844-1852` — `outputNote(text, cfiRange, color, style)`
    → `buildNoteContent(...)` (`:1782-1806`) → `insertToEditorAndTrack` or `copyTextToClipboard`.
  - `:1897-1932` — `persistInlineHighlight` writes into `books[id].notes.highlights`
    (`:1905-1910`, `saveInlineHighlights` `:1875-1895`) and applies the optimistic highlight
    (`:1911-1929`).
  - The selection toolbar is the UI entry point: `src/components/epub/SelectionToolbar.svelte`
    `handleHighlight` (`:294-302`) calls `readerService.addHighlight(...)` then
    `onInsertToNote?.(...)`. An image-capture flow would mirror this (see files-to-touch).

> **Bottom line:** there is no existing "tap an arbitrary in-book image → store bytes/metadata
> as a note" feature, but every low-level primitive exists: in-book blob→bytes (normalizer),
> blob→data URI (cover + normalizer), vault binary writes (storage service)
> and the highlight→note output chain (reader app). The work is composition, not net-new plumbing.

---

## 5. Computing a CFI / location for a DOM element; chapter title / index

### A CFI can target an `<img>` (or any element) inside a chapter.

- `EpubCfi.fromRange(range)` is exported from the vendored
  `vendor/epubcfi.mjs:322-328` (via `src/services/epub/epub-cfi.ts:16`). `fromRange` walks
  element/text child indices, so a collapsed range placed on an element (`range.selectNode(img)`
  or `setStartBefore`/`setEndAfter`) produces a valid CFI. CFI indexing counts element and text
  children (§`indexChildNodes`, `vendor/epubcfi.mjs:242-262`), so a pure-element `<img>` node is
  indexable — CFI need not cover text.
- Anchors resolve by element too: `resolveAnchorAsRange` (`FoliateVaultPublicationParser.ts:1389-1401`)
  accepts any `Node` (`createRangeForNode`, `:2113`) as an anchor and
  `findFragmentTargetElement`/`createRangeForFragment` (`:2074-2111`) reach elements by
  `id`, `name`, or `xml:id` — the same resolution path used for in-book fragment navigation.
- The runtime already turns a live in-frame Range into a CFI: `createReaderFrame.cfiFromRange`
  (`FoliateReaderService.ts:3009-3019`) → `parser.createCfiFromRange(index, range)`
  (`FoliateVaultPublicationParser.ts:489-492`) = `EpubCfi.joinIndir(baseCfi, EpubCfi.fromRange(range))`.
  So for a captured `<img>`: build a range on it in `frame.frameDocument`, call
  `frame.cfiFromRange(range)` → get the chapter-scoped CFI. `getSectionHrefForCfi`,
  `getSectionIndexForCfi` (`FoliateReaderService.ts:1292-1298`) give href/index back from a CFI.

### Chapter title / index / book progress for a given element.

- Chapter index for the element's frame: `VisibleFrameWithIndex.index` (`FoliateReaderService.ts:148-154`,
  populated `:2988-2991`); or from a CFI via `getSectionIndexForCfi` (`:1296-1298`) →
  `parser.getSectionIndexForCfi` (`FoliateVaultPublicationParser.ts:476-479`).
- Chapter title: `parser.getSectionTitleByIndex(index)` (`:396-398`) and
  `getSectionTitleByHref(href)` (`:387-394`); surfaced by the service as `getCurrentChapterTitle()`
  (`FoliateReaderService.ts:998-1000`). Location label with TOC-aware formatting:
  `parser.getSectionLocationLabelByIndex(index, format)` (`:400-415`).
- Book progress: `FoliateReaderService.getReadingProgress()` returns `currentPosition.percent`
  (`:697-699`); chapter/page positions come from `SectionDescriptor.positionStart/positionCount`
  (`FoliateVaultPublicationParser.ts:81-90`, built `:1149-1211`) and `getPaginationInfo`
  (`FoliateReaderService.ts:701-703`). Deep-link construction (the `[[book#epubcfi|...]]`
  note link) is `EpubLinkService.buildQuoteBlock`/`buildEpubLink`/`buildObsidianProtocolHref`
  (`src/services/epub/EpubLinkService.ts:837-879`, `809-834`, `700-800`), already parameterized by
  cfi + chapter index + title — exactly what `buildNoteContent` uses today
  (`EpubReaderApp.svelte:1782-1806`).

> **Bottom line:** yes — a CFI and deep link can target an `<img>` element via
> `frame.cfiFromRange`/`createCfiFromRange`, and chapter title/index/progress are all
> retrievable from the frame index. The note body can be produced by reusing
> `EpubLinkService.buildQuoteBlock`.

---

## 6. Platform differences: desktop (Electron/Chromium) vs mobile

- **Content DOM / iframe reachability is the same architecture on both**, but several
  codepaths are already mobile-specific, so image-click handling must inherit those guards:
  - `src/services/epub/foliate-runtime-patches.ts:17-57` — `normalizeDesktopFoliateSandboxValue`
    only runs `!Platform.isMobile` (`:23`); the desktop-only iframe `sandbox` patch.
    On mobile the same-origin iframe is used but sandbox semantics differ.
  - `src/services/epub/reader-tap-zones.ts:316-319` binds raw `touch*` events on the frame
    document and is enabled only on mobile paginated mode
    (`EpubReaderApp.svelte:2661-2667`, `enabled = isMobileReader() && settings.flowMode === 'paginated'`).
    Tap/click on an image must not fight these (see interaction caveat in the verdict).
  - Mobile selection / scroll freeze guards are patched into Foliate's `paginator.js`
    (`scripts/patch-foliate-paginator.mjs:193-498`), and desktop sandbox patches at
    `:176-191`. These exist precisely because touch vs mouse behavior diverges between
    Electron/Chromium and iOS/Android WebView.
  - `SelectionToolbar.svelte` handles zoom/`visualViewport` corrections for iOS
    (`:398-410`, `Platform.isIosApp`) and docks on mobile (`:111`, `isMobileToolbar`).
- **Image loading itself:** for `.epub`, images come from `loadBlob` blob URLs / inlined
  `data:` URIs on **both** platforms; there is no network dependency. The blob registry
  (`blob-url-registry.ts:2-5`) exists specifically because Electron `blob:app://obsidian.md/*`
  URLs become unreadable after revoke — a desktop quirk; on mobile,
  `installFoliateBlobIframePatch` (the mobile patch name is kept as a deprecated alias,
  `foliate-runtime-patches.ts:154-155`) normalizes blob iframe `src`→`srcdoc`. So prefer the
  **archive-level byte path (§3 path 1)** over reading a possibly-revoked blob URL; this is
  platform-agnostic and matches the loader that produced the resource.
- The reader is rendered through the same `foliate-view` host and `View` custom element on
  both platforms (`FoliateReaderService.ts:444-460`), so the DOM-reachability story in §1 is
  identical; only event semantics (touch vs click) and zoom coordinate mapping differ.

---

## FEASIBILITY verdicts

1. **Reach the in-chapter content DOM / attach `<img>` click handlers — FEASIBLE.**
   One iframe `Document` per chapter, reached as `VisibleFrameWithIndex.frameDocument`
   (same-origin). Attach image listeners in `handleLoadEvent` (`FoliateReaderService.ts:1829-1852`)
   exactly like `attachSelectionListeners`/`attachTapZoneListeners`/`attachWheelListeners`,
   with cleanup maps and `destroyAll` teardown. On mobile, gate against the tap-zone / selection
   guards (§6).

2. **Map an `<img src>`/element to a manifest item/href — FEASIBLE WITH CAVEATS.**
   Forward mapping href → archive entry / media-type exists
   (`findArchiveEntry`, `manifestMediaTypeByHref`, `inferMimeType`). But the rendered
   `<img src>` is a `data:`/`blob:` URL, not the href, and there is **no existing src→href
   reverse index**. Must add one (scan processed markup per href — `loadProcessedDocumentByHref`
   at `FoliateVaultPublicationParser.ts:1608-1653` and `inlineFoliateBlobImages` at
   `foliate-blob-markup-normalizer.ts:258-269` already iterate every `img[src]`) or resolve the
   relative `src` against `frame.href` (chapter href) via `resolveHrefAgainst`/`normalizeInternalHref`.

3. **Fetch the ORIGINAL bytes — FEASIBLE.** Preferred: `findArchiveEntry(href).async("uint8array")`
   + `inferMimeType(href)` (JSZip held in memory, `FoliateVaultPublicationParser.ts:191-256`,
   `:900-918`, `:3462-3483`). Fallbacks: `EpubBinaryData.readVaultBinaryData`
   (`EpubBinaryData.ts:232-344`) keyed on the vault `.epub` path, or the blob registry /
   `readResourceUrlAsBinary` (`blob-url-registry.ts:159-192`, `blob-url-text.ts:123-140`).

4. **Existing image handling to build on — FEASIBLE.** Cover extraction + `blobToDataUrl`
   (`FoliateVaultPublicationParser.ts:1226-1234`, `:3093-3101`) and in-book image binary→data
   URI (`foliate-blob-markup-normalizer.ts:149-169,258-269`) are direct precedents. Vault
   binary writes already exist in `EpubStorageService`; the highlight→note chain
   (`EpubReaderApp.svelte:1844-1932`, `SelectionToolbar.svelte:294-302`) is the mirror to copy.
   Schema target: `EpubBookNotes.excerpts` (`schema-v2.ts:89-93`).

5. **Compute CFI/deep link + chapter title/index/progress for the `<img>` — FEASIBLE.**
   `frame.cfiFromRange` (→ `createCfiFromRange`, `FoliateVaultPublicationParser.ts:489-492`)
   yields a chapter CFI for a range on the image; `getSectionTitleByIndex`/`getSectionIndexForCfi`
   give title/index; `getReadingProgress`/`getPaginationInfo` give progress; and
   `EpubLinkService.buildQuoteBlock` (`:837-879`) builds the note link from those.

6. **Platform — FEASIBLE (desktop & mobile) with the noted interaction guards.**
   Identical content-DOM reachability on both; use the archive-level byte path for platform
   independence, and inherit the existing mobile touch/selection tap-zone guards so an image
   tap does not also page-turn or get swallowed by selection.

### Overall: **FEASIBLE.** All primitives exist; the feature is composition plus one small
new index (src/href or element→node mapping). No cross-origin, cross-process, or new-dependency
work is required (JSZip, the DOM reach-in, CFI math, and the storage/note chain are all present).

---

## Exact files that would have to be touched (the implementation surface)

| File | Why |
|---|---|
| `src/services/epub/FoliateReaderService.ts` | Add an `attachImageCaptureListeners(doc)` (called from `handleLoadEvent`, `:1843-1847`), a `frameImgToCapture` resolver (mirroring `findHighlightAtDocumentPoint`/`createCaretRangeFromClientPoint`, `:5194-5281`), and a service method returning `{ bytes?, mimeType?, href, alt, caption?, chapterIndex, chapterTitle, cfiRange }`. Add cleanup map + teardown in `destroyAll` (`:6788-6803`). |
| `src/utils/foliate-custom-element-guard.ts` | (no change required — informational; guards `foliate-view` element registration.) |
| `src/services/epub/FoliateVaultPublicationParser.ts` | Add a **src/href → archive entry / media-type resolution** (image href lookup) and optionally a public `getImageBytesByHref(href)` using `findArchiveEntry(...).async("uint8array")` + `inferMimeType` / `manifestMediaTypeByHref` (`:3462-3483`, `:3598-3605`, `:939-966`). |
| `src/services/epub/EpubBinaryData.ts` | (reuse as-is) fallback byte source from the vault `.epub` (`:232-344`). |
| `src/utils/blob-url-registry.ts` / `src/utils/blob-url-text.ts` | (reuse as-is) fallback byte source when `src` is a retained blob URL. |
| `src/services/epub/reader-engine-types.ts` | Extend `EpubReaderEngine` with an `onReaderImageCapture(cb)` / `captureImageAtPoint(...)` method and a capture-result type (mirror `ReaderTapEvent`/`HighlightClickInfo`, `:151-188`). |
| `src/services/epub/EpubStorageService.ts` + `src/services/epub/schema-v2.ts` | Persist the image note under `books[id].notes` (`schema-v2.ts:89-93`), and/or `app.vault.createBinary` the extracted image into the vault (reuse storage-service vault-write machinery, `:1556-1560`, `:2062-2091`). |
| `src/components/epub/EpubReaderApp.svelte` + `src/components/epub/SelectionToolbar.svelte` | Wire the capture event; mirror `outputNote`/`persistInlineHighlight` (`:1844-1932`) and the toolbar `handleHighlight` (`:294-302`) to insert a Markdown note referencing the image + link (`EpubLinkService.buildQuoteBlock`), and re-use `buildNoteContent` (`:1782-1806`). |
| `src/services/epub/EpubLinkService.ts` | (reuse as-is) deep-link note construction; optionally a variant accepting an image alt/href in `buildQuoteBlock` (`:837-879`). |
| `src/services/epub/reader-tap-zones.ts` / `scripts/patch-foliate-paginator.mjs` | (only if needed to exempt images from mobile page-turn) coordinate an image-capture gesture with the tap-zone guard (`reader-tap-zones.ts:294-299` already skips interactive targets; ensure images are routed to capture instead of paging). |

**Minimal viable slice:** `FoliateReaderService.ts` (click→frame→img + byte/cfi capture),
`FoliateVaultPublicationParser.ts` (href resolution + `getImageBytesByHref`),
`reader-engine-types.ts` (result type + engine method), and
`EpubReaderApp.svelte` (+ optionally `SelectionToolbar.svelte`) for the note insert
(mirroring the existing highlight flow). `EpubStorageService`/`schema-v2` only if the note
must be persisted to `weave-data.json`/vault rather than inserted directly.
