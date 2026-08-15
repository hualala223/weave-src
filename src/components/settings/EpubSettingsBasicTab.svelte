<script lang="ts">
  import type { TextComponent } from "obsidian";
  import { onMount, untrack } from "svelte";
  import {
    normalizeContinuousReadingPositionAutoSaveEnabled,
    normalizeContinuousReadingPositionAutoSavePages,
  } from "../../config/reading-position-auto-save";
  import { EPUB_RUNTIME, normalizeEpubBookmarkFolderPath } from "../../services/epub";
  import { normalizeInterfaceLanguagePreference, tr } from "../../utils/i18n";
  import { normalizeHighlightStoragePath, normalizeWeaveParentFolder } from "../../config/paths";
  import type StandaloneEpubPlugin from "../../main";
  import { createEpubBasicSettingsActions } from "./epub-basic-settings-actions";
  import { mountEpubBasicSettings } from "./mount-epub-basic-settings";

  interface Props {
    plugin: StandaloneEpubPlugin;
  }

  let { plugin }: Props = $props();
  let t = $derived($tr);

  let stateVersion = $state(0);
  let excerptSettingsVersion = $state(0);
  let interfaceSettingsHost = $state<HTMLDivElement | null>(null);
  let premiumPreviewSettingsHost = $state<HTMLDivElement | null>(null);
  let readingSettingsHost = $state<HTMLDivElement | null>(null);
  let diagnosticsSettingsHost = $state<HTMLDivElement | null>(null);

  let bookmarkFolderInput = $state("");
  let highlightStoragePathInput = $state("");
  let weaveParentFolderInput = $state("");
  let continuousReadingPositionAutoSavePagesInput = $state("");
  let autoSavePagesTextControl = $state<TextComponent | null>(null);

  async function save(): Promise<void> {
    await plugin.saveSettings();
    stateVersion += 1;
  }

  let bookmarkFolderValue = $derived.by(() => {
    stateVersion;
    return normalizeEpubBookmarkFolderPath(plugin.settings?.bookmarkFolder);
  });

  let highlightStoragePathValue = $derived.by(() => {
    stateVersion;
    return normalizeHighlightStoragePath(plugin.settings?.highlightStoragePath);
  });

  let weaveParentFolderValue = $derived.by(() => {
    stateVersion;
    return normalizeWeaveParentFolder(plugin.settings?.weaveParentFolder);
  });

  let debugModeEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.enableDebugMode === true;
  });

  let sourceNavigationOpenInNewTab = $derived.by(() => {
    stateVersion;
    return plugin.settings?.sourceNavigationOpenInNewTab !== false;
  });

  let largeNavButtonsEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.enableLargeNavButtons === true;
  });

  let continuousReadingPositionAutoSaveEnabled = $derived.by(() => {
    stateVersion;
    return normalizeContinuousReadingPositionAutoSaveEnabled(
      plugin.settings?.continuousReadingPositionAutoSaveEnabled
    );
  });

  let continuousReadingPositionAutoSavePages = $derived.by(() => {
    stateVersion;
    return normalizeContinuousReadingPositionAutoSavePages(
      plugin.settings?.continuousReadingPositionAutoSavePages
    );
  });

  let premiumPreviewEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.showPremiumFeaturesPreview === true;
  });

  let interfaceLanguageValue = $derived.by(() => {
    stateVersion;
    return normalizeInterfaceLanguagePreference(plugin.settings?.interfaceLanguage);
  });

  const actions = createEpubBasicSettingsActions({
    plugin,
    getTranslate: () => t,
    getWeaveParentFolderValue: () => weaveParentFolderValue,
    getBookmarkFolderValue: () => bookmarkFolderValue,
    getHighlightStoragePathValue: () => highlightStoragePathValue,
    getInterfaceLanguageValue: () => interfaceLanguageValue,
    getPremiumPreviewEnabled: () => premiumPreviewEnabled,
    getContinuousReadingPositionAutoSaveEnabled: () => continuousReadingPositionAutoSaveEnabled,
    getContinuousReadingPositionAutoSavePages: () => continuousReadingPositionAutoSavePages,
    getSourceNavigationOpenInNewTab: () => sourceNavigationOpenInNewTab,
    getLargeNavButtonsEnabled: () => largeNavButtonsEnabled,
    getDebugModeEnabled: () => debugModeEnabled,
    getAutoSavePagesTextControl: () => autoSavePagesTextControl,
    setWeaveParentFolderInput: (value) => {
      weaveParentFolderInput = value;
    },
    setBookmarkFolderInput: (value) => {
      bookmarkFolderInput = value;
    },
    setHighlightStoragePathInput: (value) => {
      highlightStoragePathInput = value;
    },
    setContinuousReadingPositionAutoSavePagesInput: (value) => {
      continuousReadingPositionAutoSavePagesInput = value;
    },
    setExcerptSettingsVersion: (updater) => {
      excerptSettingsVersion = updater(excerptSettingsVersion);
    },
    save,
  });

  $effect(() => {
    bookmarkFolderValue;
    bookmarkFolderInput = bookmarkFolderValue;
  });

  $effect(() => {
    highlightStoragePathValue;
    highlightStoragePathInput = highlightStoragePathValue;
  });

  $effect(() => {
    weaveParentFolderValue;
    weaveParentFolderInput = weaveParentFolderValue;
  });

  $effect(() => {
    continuousReadingPositionAutoSavePages;
    continuousReadingPositionAutoSavePagesInput = String(continuousReadingPositionAutoSavePages);
  });

  onMount(() => {
    const handleExcerptSettingsChanged = () => {
      excerptSettingsVersion += 1;
    };
    if (typeof window !== "undefined") {
      window.addEventListener(
        EPUB_RUNTIME.events.excerptSettingsChanged,
        handleExcerptSettingsChanged
      );
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(
          EPUB_RUNTIME.events.excerptSettingsChanged,
          handleExcerptSettingsChanged
        );
      }
    };
  });

  $effect(() => {
    if (
      !interfaceSettingsHost
      || !premiumPreviewSettingsHost
      || !readingSettingsHost
      || !diagnosticsSettingsHost
    ) {
      return;
    }

    excerptSettingsVersion;
    t;

    let dispose: (() => void) | undefined;

    untrack(() => {
      dispose = mountEpubBasicSettings({
        plugin,
        t,
        hosts: {
          interface: interfaceSettingsHost,
          premiumPreview: premiumPreviewSettingsHost,
          reading: readingSettingsHost,
          diagnostics: diagnosticsSettingsHost,
        },
        snapshot: {
          interfaceLanguageValue,
          premiumPreviewEnabled,
          weaveParentFolderValue,
          weaveParentFolderInput,
          bookmarkFolderValue,
          bookmarkFolderInput,
          highlightStoragePathValue,
          highlightStoragePathInput,
          continuousReadingPositionAutoSaveEnabled,
          continuousReadingPositionAutoSavePages,
          continuousReadingPositionAutoSavePagesInput,
          sourceNavigationOpenInNewTab,
          largeNavButtonsEnabled,
          debugModeEnabled,
        },
        callbacks: {
          save,
          setWeaveParentFolderInput: (value) => {
            weaveParentFolderInput = value;
          },
          setBookmarkFolderInput: (value) => {
            bookmarkFolderInput = value;
          },
          setHighlightStoragePathInput: (value) => {
            highlightStoragePathInput = value;
          },
          setContinuousReadingPositionAutoSavePagesInput: (value) => {
            continuousReadingPositionAutoSavePagesInput = value;
          },
          setAutoSavePagesTextControl: (control) => {
            autoSavePagesTextControl = control;
          },
          updateWeaveParentFolder: actions.updateWeaveParentFolder,
          updateBookmarkFolder: actions.updateBookmarkFolder,
          updateHighlightStoragePath: actions.updateHighlightStoragePath,
          updateInterfaceLanguage: actions.updateInterfaceLanguage,
          updatePremiumPreview: actions.updatePremiumPreview,
          updateContinuousReadingPositionAutoSaveEnabled:
            actions.updateContinuousReadingPositionAutoSaveEnabled,
          updateContinuousReadingPositionAutoSavePages:
            actions.updateContinuousReadingPositionAutoSavePages,
          updateSourceNavigationOpenInNewTab: actions.updateSourceNavigationOpenInNewTab,
          updateLargeNavButtons: actions.updateLargeNavButtons,
          updateDebugMode: actions.updateDebugMode,
        },
      });
    });

    return () => dispose?.();
  });
</script>

<section class="epub-settings-section epub-settings-section--compact">
  <div class="epub-settings-group epub-settings-group--panel epub-settings-group--preview-first">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-cyan">{t("epub.settings.groups.interface")}</h3>
    </div>
    <div bind:this={interfaceSettingsHost} class="epub-native-settings-host"></div>
  </div>

  <div class="epub-settings-group epub-settings-group--panel">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-purple">{t("epub.settings.groups.premiumPreview")}</h3>
    </div>
    <div bind:this={premiumPreviewSettingsHost} class="epub-native-settings-host"></div>
  </div>

  <div class="epub-settings-group epub-settings-group--panel">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-purple">{t("epub.settings.groups.reading")}</h3>
    </div>
    <div bind:this={readingSettingsHost} class="epub-native-settings-host"></div>
  </div>

  <div class="epub-settings-group epub-settings-group--panel">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-cyan">{t("epub.settings.groups.diagnostics")}</h3>
    </div>
    <div bind:this={diagnosticsSettingsHost} class="epub-native-settings-host"></div>
  </div>
</section>
